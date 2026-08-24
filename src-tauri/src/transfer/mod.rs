//! Transfer queue with real progress reporting, cancellation and bounded
//! concurrency.
//!
//! The previous version of this module was entirely dead code: no command ever
//! constructed a `TransferQueue`, transfers ran inline one at a time, buffered
//! whole files in memory, and reported nothing to the UI. This implementation
//! drives every transfer, streams bytes through the protocol layer, and emits
//! `transfer:update` / `transfer:removed` events the frontend's queue listens to.
//!
//! # What concurrency actually buys you
//!
//! A single FTP session has one control connection, and an SFTP session is held
//! behind one lock, so two transfers on the *same* session serialize regardless
//! of `max_concurrent`. Raising the limit parallelizes work across *different*
//! sessions. The UI should say so rather than implying a single connection gets
//! faster.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};
use crate::state::{lock_or_recover, SessionKind};

/// Cap on directory recursion depth while expanding a folder transfer.
const MAX_EXPAND_DEPTH: usize = 64;

/// Cap on the total number of files one folder transfer may expand to. Depth
/// alone does not bound the work: a hostile listing that reports two
/// subdirectories at every level is exponential in depth.
const MAX_EXPAND_ENTRIES: usize = 200_000;

/// Minimum gap between progress events for one item, so a fast transfer cannot
/// flood the webview with IPC messages.
const EMIT_THROTTLE_MS: u64 = 200;

// ── Wire types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferStatus {
    Queued,
    Active,
    Paused,
    Done,
    Error,
    Cancelled,
    Skipped,
}

impl TransferStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            TransferStatus::Done
                | TransferStatus::Error
                | TransferStatus::Cancelled
                | TransferStatus::Skipped
        )
    }
}

/// What to do when the destination already exists. Deliberately has no `Ask`
/// variant: the frontend resolves prompts *before* enqueueing, so the backend
/// never blocks a worker waiting on the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConflictPolicy {
    #[default]
    Overwrite,
    Skip,
    Rename,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferItem {
    pub id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub local_path: String,
    pub remote_path: String,
    pub file_name: String,
    pub bytes_done: u64,
    /// 0 means the size was not known up front.
    pub bytes_total: u64,
    pub speed_bps: u64,
    pub eta_secs: Option<u64>,
    pub status: TransferStatus,
    pub error: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueItem {
    pub direction: TransferDirection,
    pub local_path: String,
    pub remote_path: String,
    #[serde(default)]
    pub is_dir: bool,
    #[serde(default)]
    pub on_conflict: ConflictPolicy,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueRequest {
    pub session_id: String,
    pub items: Vec<EnqueueItem>,
    pub max_concurrent: Option<usize>,
}

// ── Transfer control handed to the protocol layer ────────────────────────────

/// Cancellation flag plus a progress sink, passed into every streaming protocol
/// operation. Protocol code must call [`TransferCtl::tick`] after each chunk and
/// [`TransferCtl::check`] before each chunk so cancellation is honoured promptly.
#[derive(Clone)]
pub struct TransferCtl {
    cancel: Arc<AtomicBool>,
    progress: Arc<dyn Fn(u64) + Send + Sync>,
}

impl TransferCtl {
    /// A control that never cancels and discards progress — for internal
    /// transfers with no queue entry (deploys, script-driven copies).
    pub fn noop() -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            progress: Arc::new(|_| {}),
        }
    }

    pub fn new(cancel: Arc<AtomicBool>, progress: Arc<dyn Fn(u64) + Send + Sync>) -> Self {
        Self { cancel, progress }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// Record `delta` freshly transferred bytes.
    pub fn tick(&self, delta: u64) {
        (self.progress)(delta);
    }

    /// Bail out of a copy loop once cancellation is requested.
    pub fn check(&self) -> AppResult<()> {
        if self.is_cancelled() {
            Err(AppError::cancelled())
        } else {
            Ok(())
        }
    }
}

impl std::fmt::Debug for TransferCtl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransferCtl")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

// ── Internal bookkeeping ────────────────────────────────────────────────────

struct Job {
    item: TransferItem,
    seq: u64,
    on_conflict: ConflictPolicy,
    cancel: Arc<AtomicBool>,
    session: SessionKind,
    /// Live byte counter, written by the progress callback from worker threads.
    counter: Arc<Counter>,
}

struct Counter {
    bytes: AtomicU64,
    started: Mutex<Option<Instant>>,
    last_emit_ms: AtomicU64,
    last_sample_ms: AtomicU64,
    last_sample_bytes: AtomicU64,
    speed_bps: AtomicU64,
}

impl Counter {
    fn new() -> Self {
        Self {
            bytes: AtomicU64::new(0),
            started: Mutex::new(None),
            last_emit_ms: AtomicU64::new(0),
            last_sample_ms: AtomicU64::new(0),
            last_sample_bytes: AtomicU64::new(0),
            speed_bps: AtomicU64::new(0),
        }
    }

    fn begin(&self) {
        *lock_or_recover(&self.started) = Some(Instant::now());
    }

    fn elapsed_ms(&self) -> u64 {
        lock_or_recover(&self.started)
            .map(|s| s.elapsed().as_millis() as u64)
            .unwrap_or(0)
    }

    /// Update the exponentially smoothed speed estimate and report whether it is
    /// time to emit another progress event.
    fn sample(&self) -> bool {
        let now = self.elapsed_ms();
        let bytes = self.bytes.load(Ordering::Relaxed);

        let last_ms = self.last_sample_ms.load(Ordering::Relaxed);
        if now.saturating_sub(last_ms) >= 500 {
            let last_bytes = self.last_sample_bytes.load(Ordering::Relaxed);
            let dt = now.saturating_sub(last_ms).max(1);
            let instant_bps = (bytes.saturating_sub(last_bytes)).saturating_mul(1000) / dt;
            let prev = self.speed_bps.load(Ordering::Relaxed);
            // 30% weight on the newest sample keeps the number readable.
            let smoothed = if prev == 0 {
                instant_bps
            } else {
                (prev * 7 + instant_bps * 3) / 10
            };
            self.speed_bps.store(smoothed, Ordering::Relaxed);
            self.last_sample_ms.store(now, Ordering::Relaxed);
            self.last_sample_bytes.store(bytes, Ordering::Relaxed);
        }

        let last_emit = self.last_emit_ms.load(Ordering::Relaxed);
        if now.saturating_sub(last_emit) >= EMIT_THROTTLE_MS {
            self.last_emit_ms.store(now, Ordering::Relaxed);
            true
        } else {
            false
        }
    }
}

struct Inner {
    jobs: HashMap<String, Job>,
    max_concurrent: usize,
    active: usize,
    queue_paused: bool,
    next_seq: u64,
}

impl Inner {
    /// Oldest queued job, honouring the global pause switch.
    fn next_queued(&self) -> Option<String> {
        if self.queue_paused || self.active >= self.max_concurrent {
            return None;
        }
        self.jobs
            .values()
            .filter(|j| j.item.status == TransferStatus::Queued)
            .min_by_key(|j| j.seq)
            .map(|j| j.item.id.clone())
    }
}

pub struct TransferManager {
    inner: Mutex<Inner>,
    notify: tokio::sync::Notify,
    app: OnceLock<AppHandle>,
}

impl TransferManager {
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            inner: Mutex::new(Inner {
                jobs: HashMap::new(),
                max_concurrent: max_concurrent.clamp(1, 16),
                active: 0,
                queue_paused: false,
                next_seq: 0,
            }),
            notify: tokio::sync::Notify::new(),
            app: OnceLock::new(),
        }
    }

    /// Attach the app handle and start the dispatcher. Called once from setup.
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        if self.app.set(app).is_err() {
            tracing::warn!("transfer manager already started");
            return;
        }
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            me.dispatch_loop().await;
        });
    }

    fn emit_update(&self, item: &TransferItem) {
        if let Some(app) = self.app.get() {
            if let Err(e) = app.emit("transfer:update", item) {
                tracing::debug!(error = %e, "cannot emit transfer:update");
            }
        }
    }

    fn emit_removed(&self, id: &str) {
        if let Some(app) = self.app.get() {
            let _ = app.emit("transfer:removed", serde_json::json!({ "id": id }));
        }
    }

    // ── Public API ──────────────────────────────────────────────────────────

    pub fn list(&self) -> Vec<TransferItem> {
        let guard = lock_or_recover(&self.inner);
        let mut items: Vec<_> = guard.jobs.values().collect();
        items.sort_by_key(|j| j.seq);
        items.iter().map(|j| j.item.clone()).collect()
    }

    pub fn set_max_concurrent(&self, n: usize) {
        {
            let mut guard = lock_or_recover(&self.inner);
            guard.max_concurrent = n.clamp(1, 16);
        }
        self.notify.notify_waiters();
    }

    pub fn set_queue_paused(&self, paused: bool) {
        {
            let mut guard = lock_or_recover(&self.inner);
            guard.queue_paused = paused;
        }
        self.notify.notify_waiters();
    }

    /// Cancel a transfer. Works whether it is queued or in flight; an active
    /// transfer notices via its `TransferCtl` within one chunk.
    pub fn cancel(&self, id: &str) -> AppResult<()> {
        let item = {
            let mut guard = lock_or_recover(&self.inner);
            let job = guard
                .jobs
                .get_mut(id)
                .ok_or_else(|| AppError::not_found(id))?;
            if job.item.status.is_terminal() {
                return Ok(());
            }
            job.cancel.store(true, Ordering::Relaxed);
            if job.item.status == TransferStatus::Queued
                || job.item.status == TransferStatus::Paused
            {
                job.item.status = TransferStatus::Cancelled;
                job.item.finished_at = Some(Utc::now());
            }
            job.item.clone()
        };
        self.emit_update(&item);
        self.notify.notify_waiters();
        Ok(())
    }

    /// Hold a not-yet-started transfer back. An in-flight transfer cannot be
    /// suspended mid-stream over FTP/SFTP without renegotiating the data
    /// channel, so callers must cancel those instead of pausing them.
    pub fn pause(&self, id: &str) -> AppResult<()> {
        let item = {
            let mut guard = lock_or_recover(&self.inner);
            let job = guard
                .jobs
                .get_mut(id)
                .ok_or_else(|| AppError::not_found(id))?;
            match job.item.status {
                TransferStatus::Queued => {
                    job.item.status = TransferStatus::Paused;
                    job.item.clone()
                }
                TransferStatus::Active => {
                    return Err(AppError::config(
                        "This transfer is already in flight. Cancel it instead of pausing."
                            .to_string(),
                    ))
                }
                _ => return Ok(()),
            }
        };
        self.emit_update(&item);
        Ok(())
    }

    pub fn resume(&self, id: &str) -> AppResult<()> {
        let item = {
            let mut guard = lock_or_recover(&self.inner);
            let job = guard
                .jobs
                .get_mut(id)
                .ok_or_else(|| AppError::not_found(id))?;
            if job.item.status != TransferStatus::Paused {
                return Ok(());
            }
            job.item.status = TransferStatus::Queued;
            job.item.clone()
        };
        self.emit_update(&item);
        self.notify.notify_waiters();
        Ok(())
    }

    pub fn clear_finished(&self) -> Vec<String> {
        let removed: Vec<String> = {
            let mut guard = lock_or_recover(&self.inner);
            let ids: Vec<String> = guard
                .jobs
                .values()
                .filter(|j| j.item.status.is_terminal())
                .map(|j| j.item.id.clone())
                .collect();
            for id in &ids {
                guard.jobs.remove(id);
            }
            ids
        };
        for id in &removed {
            self.emit_removed(id);
        }
        removed
    }

    /// Drop every queue entry belonging to a session that is going away.
    pub fn cancel_session(&self, session_id: &str) {
        let ids: Vec<String> = {
            let guard = lock_or_recover(&self.inner);
            guard
                .jobs
                .values()
                .filter(|j| j.item.session_id == session_id && !j.item.status.is_terminal())
                .map(|j| j.item.id.clone())
                .collect()
        };
        for id in ids {
            let _ = self.cancel(&id);
        }
    }

    /// Expand directories, register queue entries, and wake the dispatcher.
    pub async fn enqueue(
        self: &Arc<Self>,
        session: SessionKind,
        session_id: &str,
        requests: Vec<EnqueueItem>,
        max_concurrent: Option<usize>,
    ) -> AppResult<Vec<String>> {
        if let Some(n) = max_concurrent {
            self.set_max_concurrent(n);
        }

        let mut flat: Vec<EnqueueItem> = Vec::new();
        for req in requests {
            if req.is_dir {
                // Everything this walk produces must stay under the directory the
                // user picked, so that root is the containment boundary.
                let root_local = PathBuf::from(&req.local_path);
                expand_directory(&session, &req, 0, &root_local, &mut flat).await?;
            } else {
                flat.push(req);
            }
        }

        let mut ids = Vec::with_capacity(flat.len());
        let mut created = Vec::with_capacity(flat.len());
        {
            let mut guard = lock_or_recover(&self.inner);
            for req in flat {
                let id = uuid::Uuid::new_v4().to_string();
                let seq = guard.next_seq;
                guard.next_seq += 1;

                let file_name = match req.direction {
                    TransferDirection::Upload => file_name_of(&req.local_path),
                    TransferDirection::Download => file_name_of(&req.remote_path),
                };

                let item = TransferItem {
                    id: id.clone(),
                    session_id: session_id.to_string(),
                    direction: req.direction,
                    local_path: req.local_path.clone(),
                    remote_path: req.remote_path.clone(),
                    file_name,
                    bytes_done: 0,
                    bytes_total: 0,
                    speed_bps: 0,
                    eta_secs: None,
                    status: TransferStatus::Queued,
                    error: None,
                    started_at: None,
                    finished_at: None,
                };

                created.push(item.clone());
                guard.jobs.insert(
                    id.clone(),
                    Job {
                        item,
                        seq,
                        on_conflict: req.on_conflict,
                        cancel: Arc::new(AtomicBool::new(false)),
                        session: session.clone(),
                        counter: Arc::new(Counter::new()),
                    },
                );
                ids.push(id);
            }
        }

        for item in &created {
            self.emit_update(item);
        }
        self.notify.notify_waiters();
        Ok(ids)
    }

    // ── Dispatcher ──────────────────────────────────────────────────────────

    async fn dispatch_loop(self: Arc<Self>) {
        loop {
            // Start as many jobs as the concurrency budget allows.
            loop {
                let next = {
                    let guard = lock_or_recover(&self.inner);
                    guard.next_queued()
                };
                let Some(id) = next else { break };

                let started = {
                    let mut guard = lock_or_recover(&self.inner);
                    let claimed = match guard.jobs.get_mut(&id) {
                        Some(job) if job.item.status == TransferStatus::Queued => {
                            job.item.status = TransferStatus::Active;
                            job.item.started_at = Some(Utc::now());
                            job.counter.begin();
                            Some((
                                job.item.clone(),
                                job.session.clone(),
                                job.cancel.clone(),
                                job.counter.clone(),
                                job.on_conflict,
                            ))
                        }
                        _ => None,
                    };
                    // Bump the active count only after the borrow on `jobs` ends.
                    if claimed.is_some() {
                        guard.active += 1;
                    }
                    claimed
                };

                let Some((item, session, cancel, counter, policy)) = started else {
                    continue;
                };
                self.emit_update(&item);

                let me = Arc::clone(&self);
                tauri::async_runtime::spawn(async move {
                    me.run_job(item, session, cancel, counter, policy).await;
                });
            }

            self.notify.notified().await;
        }
    }

    async fn run_job(
        self: Arc<Self>,
        item: TransferItem,
        session: SessionKind,
        cancel: Arc<AtomicBool>,
        counter: Arc<Counter>,
        policy: ConflictPolicy,
    ) {
        let id = item.id.clone();
        let outcome = self
            .execute(&item, &session, cancel, Arc::clone(&counter), policy)
            .await;

        let finished = {
            let mut guard = lock_or_recover(&self.inner);
            guard.active = guard.active.saturating_sub(1);
            match guard.jobs.get_mut(&id) {
                Some(job) => {
                    job.item.bytes_done = counter.bytes.load(Ordering::Relaxed);
                    job.item.speed_bps = counter.speed_bps.load(Ordering::Relaxed);
                    job.item.eta_secs = None;
                    job.item.finished_at = Some(Utc::now());
                    match outcome {
                        Ok(Outcome::Transferred { bytes, total }) => {
                            job.item.status = TransferStatus::Done;
                            job.item.bytes_done = bytes;
                            if total > 0 {
                                job.item.bytes_total = total;
                            } else {
                                job.item.bytes_total = bytes;
                            }
                        }
                        Ok(Outcome::Skipped) => {
                            job.item.status = TransferStatus::Skipped;
                        }
                        Err(e) if e.is_cancelled() => {
                            job.item.status = TransferStatus::Cancelled;
                        }
                        Err(e) => {
                            job.item.status = TransferStatus::Error;
                            job.item.error = Some(e.to_string());
                            tracing::warn!(
                                transfer = %id,
                                error = %e,
                                "transfer failed"
                            );
                        }
                    }
                    Some(job.item.clone())
                }
                // The entry was cleared while running; nothing to report.
                None => None,
            }
        };

        if let Some(item) = finished {
            self.emit_update(&item);
        }
        self.notify.notify_waiters();
    }

    async fn execute(
        &self,
        item: &TransferItem,
        session: &SessionKind,
        cancel: Arc<AtomicBool>,
        counter: Arc<Counter>,
        policy: ConflictPolicy,
    ) -> AppResult<Outcome> {
        // Resolve the destination against the conflict policy first.
        let (local_path, remote_path) = match item.direction {
            TransferDirection::Download => {
                let local = PathBuf::from(&item.local_path);
                match resolve_local_conflict(&local, policy)? {
                    Some(p) => (p, item.remote_path.clone()),
                    None => return Ok(Outcome::Skipped),
                }
            }
            TransferDirection::Upload => {
                let remote = resolve_remote_conflict(session, &item.remote_path, policy).await?;
                match remote {
                    Some(r) => (PathBuf::from(&item.local_path), r),
                    None => return Ok(Outcome::Skipped),
                }
            }
        };

        // Learn the total size so the UI can show a real percentage.
        let total = match item.direction {
            TransferDirection::Download => session.size(&remote_path).await.unwrap_or(0),
            TransferDirection::Upload => tokio::fs::metadata(&local_path)
                .await
                .map(|m| m.len())
                .unwrap_or(0),
        };
        self.set_total(&item.id, total);

        let ctl = self.make_ctl(&item.id, cancel, counter, total);

        let bytes = match item.direction {
            TransferDirection::Download => {
                if let Some(parent) = local_path.parent() {
                    tokio::fs::create_dir_all(parent).await.map_err(|e| {
                        AppError::io(format!("cannot create {}: {e}", parent.display()))
                    })?;
                }
                session
                    .download_to_local(&remote_path, local_path.clone(), &ctl)
                    .await?
            }
            TransferDirection::Upload => {
                if let Some(parent) = remote_parent(&remote_path) {
                    // Best effort: the directory usually exists already.
                    let _ = session.mkdir_all(&parent).await;
                }
                session
                    .upload_local(local_path.clone(), &remote_path, &ctl)
                    .await?
            }
        };

        Ok(Outcome::Transferred { bytes, total })
    }

    fn set_total(&self, id: &str, total: u64) {
        let item = {
            let mut guard = lock_or_recover(&self.inner);
            guard.jobs.get_mut(id).map(|job| {
                job.item.bytes_total = total;
                job.item.clone()
            })
        };
        if let Some(item) = item {
            self.emit_update(&item);
        }
    }

    /// Build the control object handed to the protocol layer. The progress
    /// closure runs on worker threads, so it only touches atomics and emits a
    /// throttled event.
    fn make_ctl(
        &self,
        id: &str,
        cancel: Arc<AtomicBool>,
        counter: Arc<Counter>,
        total: u64,
    ) -> TransferCtl {
        let app = self.app.get().cloned();
        let id = id.to_string();
        let progress = Arc::new(move |delta: u64| {
            let done = counter.bytes.fetch_add(delta, Ordering::Relaxed) + delta;
            if !counter.sample() {
                return;
            }
            let Some(app) = app.as_ref() else { return };
            let speed = counter.speed_bps.load(Ordering::Relaxed);
            let eta = if speed > 0 && total > done {
                Some((total - done) / speed)
            } else {
                None
            };
            // A lightweight partial update; the full item is emitted on state
            // changes. Shape matches TransferItem's camelCase fields.
            let _ = app.emit(
                "transfer:update",
                serde_json::json!({
                    "id": id,
                    "bytesDone": done,
                    "bytesTotal": total,
                    "speedBps": speed,
                    "etaSecs": eta,
                    "status": "active",
                    "partial": true,
                }),
            );
        });

        TransferCtl::new(cancel, progress)
    }
}

enum Outcome {
    Transferred { bytes: u64, total: u64 },
    Skipped,
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn file_name_of(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn remote_parent(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    let idx = trimmed.rfind('/')?;
    if idx == 0 {
        return Some("/".to_string());
    }
    Some(trimmed[..idx].to_string())
}

/// Apply the conflict policy locally. `None` means "skip this item".
fn resolve_local_conflict(path: &Path, policy: ConflictPolicy) -> AppResult<Option<PathBuf>> {
    if !path.exists() {
        return Ok(Some(path.to_path_buf()));
    }
    match policy {
        ConflictPolicy::Overwrite => Ok(Some(path.to_path_buf())),
        ConflictPolicy::Skip => Ok(None),
        ConflictPolicy::Rename => {
            let stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let ext = path.extension().map(|s| s.to_string_lossy().to_string());
            let parent = path.parent().unwrap_or_else(|| Path::new("."));
            for n in 1..10_000 {
                let candidate = match &ext {
                    Some(ext) => parent.join(format!("{stem} ({n}).{ext}")),
                    None => parent.join(format!("{stem} ({n})")),
                };
                if !candidate.exists() {
                    return Ok(Some(candidate));
                }
            }
            Err(AppError::io(format!(
                "cannot find a free name next to {}",
                path.display()
            )))
        }
    }
}

/// Apply the conflict policy on the remote side. `None` means "skip".
async fn resolve_remote_conflict(
    session: &SessionKind,
    remote_path: &str,
    policy: ConflictPolicy,
) -> AppResult<Option<String>> {
    // `size` failing is treated as "does not exist", which is the common case
    // for a fresh upload; a genuine error surfaces later on the transfer itself.
    let exists = session.size(remote_path).await.is_ok();
    if !exists {
        return Ok(Some(remote_path.to_string()));
    }
    match policy {
        ConflictPolicy::Overwrite => Ok(Some(remote_path.to_string())),
        ConflictPolicy::Skip => Ok(None),
        ConflictPolicy::Rename => {
            let (base, ext) = split_remote_ext(remote_path);
            for n in 1..10_000 {
                let candidate = match ext {
                    Some(ext) => format!("{base} ({n}).{ext}"),
                    None => format!("{base} ({n})"),
                };
                if session.size(&candidate).await.is_err() {
                    return Ok(Some(candidate));
                }
            }
            Err(AppError::io(format!(
                "cannot find a free remote name next to {remote_path}"
            )))
        }
    }
}

fn split_remote_ext(path: &str) -> (&str, Option<&str>) {
    let file_start = path.rfind('/').map(|i| i + 1).unwrap_or(0);
    match path[file_start..].rfind('.') {
        Some(dot) if dot > 0 => {
            let abs = file_start + dot;
            (&path[..abs], Some(&path[abs + 1..]))
        }
        _ => (path, None),
    }
}

/// Walk a directory into individual file transfers.
///
/// Three separate limits apply, because the remote side of this walk is
/// attacker-controlled:
///
/// * Symlinked directories are never followed — a remote `loop -> .` used to send
///   the old recursive uploader into an unbounded download.
/// * `MAX_EXPAND_DEPTH` caps nesting.
/// * `MAX_EXPAND_ENTRIES` caps the *total* number of files produced. Depth alone
///   is not enough: a server returning two subdirectories at every level yields
///   2^depth nodes, so the walk would never finish and the queue would grow until
///   the process ran out of memory.
///
/// Entry names are validated in the protocol layer (`ftp::types::is_safe_entry_name`),
/// and the local path each one produces is re-checked here for containment, so a
/// hostile listing cannot place a download outside the directory the user chose.
fn expand_directory<'a>(
    session: &'a SessionKind,
    req: &'a EnqueueItem,
    depth: usize,
    root_local: &'a Path,
    out: &'a mut Vec<EnqueueItem>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<()>> + Send + 'a>> {
    Box::pin(async move {
        if depth > MAX_EXPAND_DEPTH {
            return Err(AppError::config(format!(
                "directory nesting exceeds {MAX_EXPAND_DEPTH} levels at {}",
                req.remote_path
            )));
        }
        if out.len() >= MAX_EXPAND_ENTRIES {
            return Err(AppError::config(format!(
                "this transfer expands to more than {MAX_EXPAND_ENTRIES} files; \
                 narrow the selection"
            )));
        }

        match req.direction {
            TransferDirection::Download => {
                let entries = session.list(&req.remote_path).await?;
                for entry in entries {
                    if entry.is_symlink {
                        tracing::info!(path = %entry.path, "skipping remote symlink");
                        continue;
                    }
                    // Defence in depth: the protocol layer already rejects names
                    // that are not a single component, but this walk is the one
                    // place where a remote string becomes a local write target,
                    // so verify containment rather than assuming it.
                    if !crate::ftp::types::is_safe_entry_name(&entry.name) {
                        tracing::warn!(entry = %entry.name, "skipping unsafe entry name");
                        continue;
                    }
                    let local = Path::new(&req.local_path).join(&entry.name);
                    if !local.starts_with(root_local) {
                        tracing::warn!(
                            path = %local.display(),
                            root = %root_local.display(),
                            "skipping an entry that would escape the download directory"
                        );
                        continue;
                    }
                    let child = EnqueueItem {
                        direction: TransferDirection::Download,
                        local_path: local.to_string_lossy().to_string(),
                        remote_path: entry.path.clone(),
                        is_dir: entry.is_dir,
                        on_conflict: req.on_conflict,
                    };
                    if entry.is_dir {
                        expand_directory(session, &child, depth + 1, root_local, out).await?;
                    } else {
                        out.push(child);
                        if out.len() >= MAX_EXPAND_ENTRIES {
                            return Err(AppError::config(format!(
                                "this transfer expands to more than {MAX_EXPAND_ENTRIES} \
                                 files; narrow the selection"
                            )));
                        }
                    }
                }
            }
            TransferDirection::Upload => {
                let mut dir = tokio::fs::read_dir(&req.local_path)
                    .await
                    .map_err(|e| AppError::io(format!("cannot read {}: {e}", req.local_path)))?;
                while let Some(entry) = dir
                    .next_entry()
                    .await
                    .map_err(|e| AppError::io(format!("cannot walk {}: {e}", req.local_path)))?
                {
                    let meta = match entry.metadata().await {
                        Ok(m) => m,
                        Err(e) => {
                            tracing::warn!(path = ?entry.path(), error = %e, "skipping unreadable entry");
                            continue;
                        }
                    };
                    if meta.is_symlink() {
                        tracing::info!(path = ?entry.path(), "skipping local symlink");
                        continue;
                    }
                    let name = entry.file_name().to_string_lossy().to_string();
                    let child = EnqueueItem {
                        direction: TransferDirection::Upload,
                        local_path: entry.path().to_string_lossy().to_string(),
                        remote_path: crate::ftp::RemoteFile::join_path(&req.remote_path, &name),
                        is_dir: meta.is_dir(),
                        on_conflict: req.on_conflict,
                    };
                    if meta.is_dir() {
                        expand_directory(session, &child, depth + 1, root_local, out).await?;
                    } else {
                        out.push(child);
                        if out.len() >= MAX_EXPAND_ENTRIES {
                            return Err(AppError::config(format!(
                                "this transfer expands to more than {MAX_EXPAND_ENTRIES} \
                                 files; narrow the selection"
                            )));
                        }
                    }
                }
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_name_handles_both_separators() {
        assert_eq!(file_name_of("/var/www/a.txt"), "a.txt");
        assert_eq!(file_name_of("C:\\tmp\\a.txt"), "a.txt");
        assert_eq!(file_name_of("/var/www/"), "www");
        assert_eq!(file_name_of("a.txt"), "a.txt");
    }

    #[test]
    fn remote_parent_walks_up_one_level() {
        assert_eq!(remote_parent("/var/www/a.txt").as_deref(), Some("/var/www"));
        assert_eq!(remote_parent("/a.txt").as_deref(), Some("/"));
        assert_eq!(remote_parent("a.txt"), None);
        assert_eq!(remote_parent("/var/www/").as_deref(), Some("/var"));
    }

    #[test]
    fn remote_extension_split_ignores_directory_dots() {
        assert_eq!(split_remote_ext("/a.b/c.txt"), ("/a.b/c", Some("txt")));
        assert_eq!(split_remote_ext("/a.b/c"), ("/a.b/c", None));
        // A leading dot is part of the name, not an extension separator.
        assert_eq!(split_remote_ext("/dir/.bashrc"), ("/dir/.bashrc", None));
    }

    #[test]
    fn skip_policy_declines_existing_local_file() {
        let dir = std::env::temp_dir().join(format!("ftpie-conf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.txt");
        std::fs::write(&path, b"x").unwrap();

        assert!(resolve_local_conflict(&path, ConflictPolicy::Skip)
            .unwrap()
            .is_none());
        assert_eq!(
            resolve_local_conflict(&path, ConflictPolicy::Overwrite).unwrap(),
            Some(path.clone())
        );

        let renamed = resolve_local_conflict(&path, ConflictPolicy::Rename)
            .unwrap()
            .unwrap();
        assert_eq!(renamed.file_name().unwrap(), "a (1).txt");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn absent_local_file_is_never_a_conflict() {
        let path = std::env::temp_dir().join(format!("ftpie-absent-{}", uuid::Uuid::new_v4()));
        assert_eq!(
            resolve_local_conflict(&path, ConflictPolicy::Skip).unwrap(),
            Some(path)
        );
    }

    #[test]
    fn ctl_reports_cancellation() {
        let flag = Arc::new(AtomicBool::new(false));
        let ctl = TransferCtl::new(Arc::clone(&flag), Arc::new(|_| {}));
        assert!(ctl.check().is_ok());
        flag.store(true, Ordering::Relaxed);
        assert!(ctl.is_cancelled());
        assert!(ctl.check().unwrap_err().is_cancelled());
    }

    #[test]
    fn ctl_forwards_progress_deltas() {
        let total = Arc::new(AtomicU64::new(0));
        let sink = Arc::clone(&total);
        let ctl = TransferCtl::new(
            Arc::new(AtomicBool::new(false)),
            Arc::new(move |d| {
                sink.fetch_add(d, Ordering::Relaxed);
            }),
        );
        ctl.tick(100);
        ctl.tick(23);
        assert_eq!(total.load(Ordering::Relaxed), 123);
    }

    #[test]
    fn noop_ctl_is_inert() {
        let ctl = TransferCtl::noop();
        ctl.tick(999);
        assert!(!ctl.is_cancelled());
        assert!(ctl.check().is_ok());
    }

    #[test]
    fn terminal_statuses_are_classified() {
        assert!(TransferStatus::Done.is_terminal());
        assert!(TransferStatus::Error.is_terminal());
        assert!(TransferStatus::Cancelled.is_terminal());
        assert!(TransferStatus::Skipped.is_terminal());
        assert!(!TransferStatus::Queued.is_terminal());
        assert!(!TransferStatus::Active.is_terminal());
        assert!(!TransferStatus::Paused.is_terminal());
    }

    #[test]
    fn concurrency_is_clamped_to_a_sane_range() {
        let m = TransferManager::new(1000);
        assert_eq!(lock_or_recover(&m.inner).max_concurrent, 16);
        m.set_max_concurrent(0);
        assert_eq!(lock_or_recover(&m.inner).max_concurrent, 1);
        m.set_max_concurrent(4);
        assert_eq!(lock_or_recover(&m.inner).max_concurrent, 4);
    }

    #[test]
    fn queue_serializes_camel_case() {
        let item = TransferItem {
            id: "i".into(),
            session_id: "s".into(),
            direction: TransferDirection::Download,
            local_path: "/l".into(),
            remote_path: "/r".into(),
            file_name: "f".into(),
            bytes_done: 1,
            bytes_total: 2,
            speed_bps: 3,
            eta_secs: Some(4),
            status: TransferStatus::Active,
            error: None,
            started_at: None,
            finished_at: None,
        };
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json["bytesDone"], 1);
        assert_eq!(json["speedBps"], 3);
        assert_eq!(json["status"], "active");
        assert_eq!(json["direction"], "download");
    }
}
