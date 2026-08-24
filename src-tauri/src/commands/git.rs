//! Deploy commands.
//!
//! [`crate::git`] produces a plan; this module executes it against a live
//! session. Keeping the two apart is what makes `dryRun` genuinely side-effect
//! free: a dry run builds the plan, emits progress, and returns — it never takes
//! a session, never touches the network, and never writes a history record.
//!
//! Execution order is deliberate: uploads first, deletions afterwards. If the
//! run is interrupted the server is left with new content present alongside some
//! stale files, which is recoverable; the reverse order could leave a live site
//! with files removed and their replacements missing.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, State, Window};

use crate::deploy_history::{self, DeployRecord};
use crate::error::{AppError, AppResult};
use crate::git::{
    self, DeployPlan, DeployRequest, GitStatus, PlannedDelete, PlannedUpload, UploadSource,
};
use crate::state::{lock_or_recover, AppState, SessionKind, SessionMeta};
use crate::transfer::TransferCtl;

// ── Read-only git commands ───────────────────────────────────────────────────

#[tauri::command]
pub async fn get_git_status(repo_path: String) -> AppResult<GitStatus> {
    tokio::task::spawn_blocking(move || git::get_status(Path::new(&repo_path))).await?
}

#[tauri::command]
pub async fn list_branches(repo_path: String) -> AppResult<Vec<String>> {
    tokio::task::spawn_blocking(move || git::list_branches(Path::new(&repo_path))).await?
}

#[tauri::command]
pub async fn list_tags(repo_path: String) -> AppResult<Vec<String>> {
    tokio::task::spawn_blocking(move || git::list_tags(Path::new(&repo_path))).await?
}

// ── Wire types ───────────────────────────────────────────────────────────────

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployArgs {
    pub session_id: String,
    pub repo_path: String,
    pub remote_base_path: String,
    /// Branch, tag, or commit-ish to deploy. Defaults to `HEAD`.
    #[serde(default)]
    pub rev: Option<String>,
    /// Explicit diff base. When absent and `useHistoryBase` is set, the last
    /// successful deploy to the same host + remote directory is used.
    #[serde(default, alias = "sinceRef")]
    pub base_rev: Option<String>,
    #[serde(default = "default_true")]
    pub use_history_base: bool,
    #[serde(default)]
    pub exclude_patterns: Vec<String>,
    /// Ship the dirty working tree (including untracked files) on top of the
    /// resolved commit. Off by default: deploys should be reproducible.
    #[serde(default)]
    pub include_uncommitted: bool,
    /// Build and return the plan without contacting the server.
    #[serde(default)]
    pub dry_run: bool,
    /// Caller-supplied id so `cancel_deploy` can target this run. A fresh id is
    /// generated when absent.
    #[serde(default)]
    pub deploy_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeployPhase {
    /// Reading the repository and building the plan.
    Scanning,
    Uploading,
    Deleting,
    Finished,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeployAction {
    Upload,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OutcomeStatus {
    Done,
    Failed,
    /// Planned but not attempted (dry run, cancelled run, or already absent).
    Skipped,
}

/// Payload of the `deploy:progress` event, emitted on the main window.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployProgress {
    pub deploy_id: String,
    pub phase: DeployPhase,
    /// 1-based index of the operation being reported; 0 while scanning.
    pub current: usize,
    /// Total planned operations (uploads + deletes); 0 while scanning.
    pub total: usize,
    /// Repo-relative path, forward slashes.
    pub path: String,
    pub remote_path: String,
    /// Bytes transferred so far across the whole deploy.
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOutcome {
    pub path: String,
    pub remote_path: String,
    pub action: DeployAction,
    pub status: OutcomeStatus,
    pub bytes: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployOutcome {
    pub deploy_id: String,
    pub dry_run: bool,
    /// The full plan — for a dry run this *is* the result the UI shows.
    pub plan: DeployPlan,
    pub uploaded: usize,
    pub deleted: usize,
    pub failed: usize,
    pub skipped: usize,
    pub bytes: u64,
    pub duration_ms: u64,
    pub cancelled: bool,
    pub success: bool,
    pub files: Vec<FileOutcome>,
    /// Id of the deploy-history record, absent for dry runs.
    pub record_id: Option<String>,
}

// ── Cancellation registry ────────────────────────────────────────────────────

fn cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static REG: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_cancel(deploy_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    lock_or_recover(cancels()).insert(deploy_id.to_string(), Arc::clone(&flag));
    flag
}

fn unregister_cancel(deploy_id: &str) {
    lock_or_recover(cancels()).remove(deploy_id);
}

/// Ask a running deploy to stop at the next file boundary.
///
/// A deploy is not transactional: already-uploaded files stay uploaded. The
/// partial result is reported in the returned [`DeployOutcome`] and recorded in
/// history with `success = false`.
#[tauri::command]
pub async fn cancel_deploy(deploy_id: String) -> AppResult<()> {
    match lock_or_recover(cancels()).get(&deploy_id) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            Ok(())
        }
        None => Err(AppError::not_found(format!("deploy {deploy_id}"))),
    }
}

/// Clears the cancellation entry even if the deploy returns early.
struct CancelGuard(String);
impl Drop for CancelGuard {
    fn drop(&mut self) {
        unregister_cancel(&self.0);
    }
}

/// Removes the blob staging directory even if the deploy returns early.
struct StagingGuard(PathBuf);
impl Drop for StagingGuard {
    fn drop(&mut self) {
        if self.0.exists() {
            if let Err(e) = std::fs::remove_dir_all(&self.0) {
                tracing::warn!(path = %self.0.display(), error = %e, "cannot remove deploy staging directory");
            }
        }
    }
}

// ── deploy_branch ────────────────────────────────────────────────────────────

/// Deploy a committed tree to the remote base directory.
///
/// The plan is a diff, so only what changed moves:
/// * `baseRev` given -> diff that commit's tree against the target tree;
/// * otherwise, and with `useHistoryBase`, the commit of the last successful
///   deploy to the same host + user + repository + remote directory is used as
///   the base, provided that commit still exists locally;
/// * with no usable base, the entire target tree is uploaded (a first deploy).
///
/// Deletions and renames propagate: a file removed between the base and the
/// target is deleted on the server, and a rename uploads the new path *and*
/// deletes the old one.
#[tauri::command]
pub async fn deploy_branch(
    args: DeployArgs,
    state: State<'_, AppState>,
    window: Window,
) -> AppResult<DeployOutcome> {
    let started = std::time::Instant::now();
    let deploy_id = args
        .deploy_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let cancel = register_cancel(&deploy_id);
    let _cancel_guard = CancelGuard(deploy_id.clone());

    // Identity is required even for a dry run: the history base depends on which
    // server we are talking to, and the UI must show the real target.
    let meta = state.session_meta(&args.session_id).ok_or_else(|| {
        AppError::config(format!(
            "Session '{}' is not connected. Reconnect and try again.",
            args.session_id
        ))
    })?;

    emit_progress(&window, &deploy_id, DeployPhase::Scanning, 0, 0, "", "", 0);

    // Resolve the diff base before planning.
    let base_rev = match args.base_rev.as_deref().map(str::trim) {
        Some(explicit) if !explicit.is_empty() => Some(explicit.to_string()),
        _ if args.use_history_base => {
            let repo_path = args.repo_path.clone();
            let remote_base = args.remote_base_path.clone();
            let meta_for_lookup = meta.clone();
            tokio::task::spawn_blocking(move || {
                last_deployed_commit(&meta_for_lookup, &repo_path, &remote_base)
            })
            .await?
        }
        _ => None,
    };

    let request = DeployRequest {
        rev: args.rev.clone().unwrap_or_default(),
        base_rev,
        remote_base_path: args.remote_base_path.clone(),
        exclude_patterns: args.exclude_patterns.clone(),
        include_uncommitted: args.include_uncommitted,
    };

    let repo_path = PathBuf::from(&args.repo_path);
    let plan = {
        let repo_path = repo_path.clone();
        tokio::task::spawn_blocking(move || git::plan_deploy(&repo_path, &request)).await??
    };

    if args.dry_run {
        // No session, no network, no history: just the plan.
        emit_progress(
            &window,
            &deploy_id,
            DeployPhase::Finished,
            plan.total_operations(),
            plan.total_operations(),
            "",
            "",
            0,
        );
        return Ok(dry_run_outcome(deploy_id, plan, started));
    }

    let session = state.require_session(&args.session_id)?;
    let outcome = execute_plan(
        &deploy_id, &plan, &session, &repo_path, &window, &cancel, started,
    )
    .await?;

    let record_id = write_history(&meta, &args.repo_path, &plan, &outcome).await;
    Ok(DeployOutcome {
        record_id,
        ..outcome
    })
}

fn dry_run_outcome(
    deploy_id: String,
    plan: DeployPlan,
    started: std::time::Instant,
) -> DeployOutcome {
    let files: Vec<FileOutcome> = plan
        .uploads
        .iter()
        .map(|u| FileOutcome {
            path: u.path.clone(),
            remote_path: u.remote_path.clone(),
            action: DeployAction::Upload,
            status: OutcomeStatus::Skipped,
            bytes: u.size,
            error: None,
        })
        .chain(plan.deletes.iter().map(|d| FileOutcome {
            path: d.path.clone(),
            remote_path: d.remote_path.clone(),
            action: DeployAction::Delete,
            status: OutcomeStatus::Skipped,
            bytes: 0,
            error: None,
        }))
        .collect();

    DeployOutcome {
        deploy_id,
        dry_run: true,
        uploaded: 0,
        deleted: 0,
        failed: 0,
        skipped: files.len(),
        bytes: 0,
        duration_ms: started.elapsed().as_millis() as u64,
        cancelled: false,
        success: true,
        files,
        record_id: None,
        plan,
    }
}

// ── Plan execution ───────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
async fn execute_plan(
    deploy_id: &str,
    plan: &DeployPlan,
    session: &SessionKind,
    repo_path: &Path,
    window: &Window,
    cancel: &Arc<AtomicBool>,
    started: std::time::Instant,
) -> AppResult<DeployOutcome> {
    let total = plan.total_operations();
    let mut files: Vec<FileOutcome> = Vec::with_capacity(total);
    let mut uploaded = 0usize;
    let mut deleted = 0usize;
    let mut failed = 0usize;
    let mut skipped = 0usize;
    let mut bytes = 0u64;
    let mut current = 0usize;
    let mut cancelled = false;
    let mut made_dirs: HashSet<String> = HashSet::new();

    let staging = std::env::temp_dir().join(format!("ftpie-deploy-{deploy_id}"));
    let _staging_guard = StagingGuard(staging.clone());

    // Worktree-sourced uploads read the real working directory; `open_repo`
    // searches upwards, so the caller's path is not necessarily it.
    let workdir = if plan
        .uploads
        .iter()
        .any(|u| u.source == UploadSource::Worktree)
    {
        let p = repo_path.to_path_buf();
        Some(tokio::task::spawn_blocking(move || git::repo_workdir(&p)).await??)
    } else {
        None
    };

    // Opened lazily and shuttled through `spawn_blocking` (Repository is Send,
    // not Sync) so the repository is opened once for the whole deploy.
    let mut repo: Option<git2::Repository> = None;

    for upload in &plan.uploads {
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        current += 1;
        emit_progress(
            window,
            deploy_id,
            DeployPhase::Uploading,
            current,
            total,
            &upload.path,
            &upload.remote_path,
            bytes,
        );

        match upload_one(
            upload,
            session,
            &staging,
            workdir.as_deref(),
            repo_path,
            &mut repo,
            &mut made_dirs,
        )
        .await
        {
            Ok(n) => {
                uploaded += 1;
                bytes += n;
                files.push(FileOutcome {
                    path: upload.path.clone(),
                    remote_path: upload.remote_path.clone(),
                    action: DeployAction::Upload,
                    status: OutcomeStatus::Done,
                    bytes: n,
                    error: None,
                });
            }
            Err(e) if e.is_cancelled() => {
                cancelled = true;
                files.push(FileOutcome {
                    path: upload.path.clone(),
                    remote_path: upload.remote_path.clone(),
                    action: DeployAction::Upload,
                    status: OutcomeStatus::Skipped,
                    bytes: 0,
                    error: None,
                });
                break;
            }
            Err(e) => {
                failed += 1;
                tracing::warn!(path = %upload.path, error = %e, "deploy upload failed");
                files.push(FileOutcome {
                    path: upload.path.clone(),
                    remote_path: upload.remote_path.clone(),
                    action: DeployAction::Upload,
                    status: OutcomeStatus::Failed,
                    bytes: 0,
                    error: Some(e.to_string()),
                });
            }
        }
    }

    // Deletions run only after every upload has been attempted, so an aborted
    // deploy never leaves a site with content removed and no replacement.
    if !cancelled {
        for del in &plan.deletes {
            if cancel.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }
            current += 1;
            emit_progress(
                window,
                deploy_id,
                DeployPhase::Deleting,
                current,
                total,
                &del.path,
                &del.remote_path,
                bytes,
            );
            match delete_one(del, session).await {
                Ok(true) => {
                    deleted += 1;
                    files.push(FileOutcome {
                        path: del.path.clone(),
                        remote_path: del.remote_path.clone(),
                        action: DeployAction::Delete,
                        status: OutcomeStatus::Done,
                        bytes: 0,
                        error: None,
                    });
                }
                // Already gone: the desired state, not a failure.
                Ok(false) => {
                    skipped += 1;
                    files.push(FileOutcome {
                        path: del.path.clone(),
                        remote_path: del.remote_path.clone(),
                        action: DeployAction::Delete,
                        status: OutcomeStatus::Skipped,
                        bytes: 0,
                        error: None,
                    });
                }
                Err(e) if e.is_cancelled() => {
                    cancelled = true;
                    break;
                }
                Err(e) => {
                    failed += 1;
                    tracing::warn!(path = %del.path, error = %e, "deploy delete failed");
                    files.push(FileOutcome {
                        path: del.path.clone(),
                        remote_path: del.remote_path.clone(),
                        action: DeployAction::Delete,
                        status: OutcomeStatus::Failed,
                        bytes: 0,
                        error: Some(e.to_string()),
                    });
                }
            }
        }
    }

    // Anything the loops never reached is reported as skipped rather than
    // silently vanishing from the outcome.
    let attempted = files.len();
    if attempted < total {
        skipped += total - attempted;
    }

    emit_progress(
        window,
        deploy_id,
        DeployPhase::Finished,
        current,
        total,
        "",
        "",
        bytes,
    );

    tracing::info!(
        deploy_id,
        uploaded,
        deleted,
        failed,
        skipped,
        bytes,
        cancelled,
        "deploy finished"
    );

    Ok(DeployOutcome {
        deploy_id: deploy_id.to_string(),
        dry_run: false,
        plan: plan.clone(),
        uploaded,
        deleted,
        failed,
        skipped,
        bytes,
        duration_ms: started.elapsed().as_millis() as u64,
        cancelled,
        success: failed == 0 && !cancelled,
        files,
        record_id: None,
    })
}

#[allow(clippy::too_many_arguments)]
async fn upload_one(
    upload: &PlannedUpload,
    session: &SessionKind,
    staging: &Path,
    workdir: Option<&Path>,
    repo_path: &Path,
    repo: &mut Option<git2::Repository>,
    made_dirs: &mut HashSet<String>,
) -> AppResult<u64> {
    // Resolve the local bytes: a committed blob is staged to a temp file so the
    // upload still streams; a worktree file is uploaded in place.
    let (local, staged) = match upload.source {
        UploadSource::Worktree => {
            let root = workdir.ok_or_else(|| {
                AppError::internal("worktree upload planned without a working directory")
            })?;
            (root.join(&upload.path), false)
        }
        UploadSource::Tree => {
            let sha = upload.blob_sha.clone().ok_or_else(|| {
                AppError::internal(format!("no blob id planned for {}", upload.path))
            })?;
            let dest = staging.join(&upload.path);
            if repo.is_none() {
                let p = repo_path.to_path_buf();
                *repo = Some(
                    tokio::task::spawn_blocking(move || git::open_repo(&p))
                        .await
                        .map_err(AppError::from)??,
                );
            }
            // Move the repository into the blocking task and take it back out.
            let owned = repo.take().expect("repository was just opened");
            let dest_for_task = dest.clone();
            let (owned, result) = tokio::task::spawn_blocking(move || {
                let r = git::write_blob_to(&owned, &sha, &dest_for_task);
                (owned, r)
            })
            .await?;
            *repo = Some(owned);
            result?;
            (dest, true)
        }
    };

    // Recursive parent creation: plain FTP `MKD` is not recursive, which is why
    // the previous `let _ = mkdir(parent)` silently produced failed deploys into
    // fresh nested directories.
    if let Some(parent) = git::remote_parent(&upload.remote_path) {
        if made_dirs.insert(parent.clone()) {
            session.mkdir_all(&parent).await?;
        }
    }

    let result = session
        .upload_local(local.clone(), &upload.remote_path, &TransferCtl::noop())
        .await;

    if staged {
        let _ = std::fs::remove_file(&local);
    }
    result
}

/// `Ok(false)` means the remote path was already absent.
async fn delete_one(del: &PlannedDelete, session: &SessionKind) -> AppResult<bool> {
    match session.delete_file(&del.remote_path).await {
        Ok(()) => Ok(true),
        Err(AppError::NotFound { .. }) => Ok(false),
        Err(e) => Err(e),
    }
}

#[allow(clippy::too_many_arguments)]
fn emit_progress(
    window: &Window,
    deploy_id: &str,
    phase: DeployPhase,
    current: usize,
    total: usize,
    path: &str,
    remote_path: &str,
    bytes: u64,
) {
    let payload = DeployProgress {
        deploy_id: deploy_id.to_string(),
        phase,
        current,
        total,
        path: path.to_string(),
        remote_path: remote_path.to_string(),
        bytes,
    };
    if let Err(e) = window.emit("deploy:progress", payload) {
        tracing::debug!(error = %e, "cannot emit deploy:progress");
    }
}

// ── History ──────────────────────────────────────────────────────────────────

/// Newest successful deploy commit for this exact target, if it is still in the
/// repository. A commit that was force-pushed away or garbage-collected cannot
/// be diffed against, so it is ignored and the deploy falls back to a full tree.
fn last_deployed_commit(meta: &SessionMeta, repo_path: &str, remote_base: &str) -> Option<String> {
    let repo = Path::new(repo_path);
    deploy_history::list(0)
        .into_iter()
        .filter(|r| {
            r.success
                && r.server_host == meta.host
                && r.server_user == meta.username
                && r.remote_base_path == remote_base
                && !r.commit_sha.is_empty()
        })
        // Records are already newest-first; accept the first usable one.
        .find(|r| {
            (r.repo_path.is_empty() || Path::new(&r.repo_path) == repo)
                && git::rev_exists(repo, &r.commit_sha)
        })
        .map(|r| r.commit_sha)
}

/// Persist the outcome. A history write failure must not fail the deploy that
/// already happened, so it is logged and reported as a missing record id.
async fn write_history(
    meta: &SessionMeta,
    repo_path: &str,
    plan: &DeployPlan,
    outcome: &DeployOutcome,
) -> Option<String> {
    let mut record = DeployRecord::new(&meta.host, &meta.username, meta.protocol);
    record.repo_path = repo_path.to_string();
    record.remote_base_path = plan.remote_base_path.clone();
    record.branch = plan.branch.clone();
    record.commit_sha = plan.commit_sha.clone();
    record.files_uploaded = outcome
        .files
        .iter()
        .filter(|f| f.action == DeployAction::Upload && f.status == OutcomeStatus::Done)
        .map(|f| f.path.clone())
        .collect();
    record.files_deleted = outcome
        .files
        .iter()
        .filter(|f| f.action == DeployAction::Delete && f.status == OutcomeStatus::Done)
        .map(|f| f.path.clone())
        .collect();
    record.bytes = outcome.bytes;
    record.duration_ms = outcome.duration_ms;
    record.success = outcome.success;
    record.error = if outcome.cancelled {
        Some("Deploy cancelled; already-transferred files were left in place.".to_string())
    } else if outcome.failed > 0 {
        Some(format!("{} file operation(s) failed", outcome.failed))
    } else {
        None
    };

    // A deploy that shipped uncommitted work is not reproducible from its commit
    // alone; say so in the record rather than letting a rollback imply otherwise.
    if plan.include_uncommitted {
        let note = "Included uncommitted working-tree changes; this deploy cannot be reproduced from its commit alone.";
        record.error = Some(match record.error.take() {
            Some(existing) => format!("{existing}. {note}"),
            None => note.to_string(),
        });
    }

    let id = record.id.clone();
    let saved = tokio::task::spawn_blocking(move || deploy_history::save_record(record)).await;
    match saved {
        Ok(Ok(())) => Some(id),
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "cannot record deploy history");
            None
        }
        Err(e) => {
            tracing::warn!(error = %e, "deploy history task failed");
            None
        }
    }
}

/// Newest-first deploy history. `limit` omitted or `0` returns everything (the
/// store keeps at most 200 records).
#[tauri::command]
pub async fn list_deploy_history(limit: Option<usize>) -> AppResult<Vec<DeployRecord>> {
    let limit = limit.unwrap_or(0);
    Ok(tokio::task::spawn_blocking(move || deploy_history::list(limit)).await?)
}

// ── Rollback ─────────────────────────────────────────────────────────────────

/// Put the server back into the state a recorded deploy left it in.
///
/// The record names a commit and the exact paths that deploy touched. For each
/// of those paths this re-deploys the content committed at that commit, and
/// deletes the ones that did not exist there.
///
/// # What this genuinely does
/// * Re-uploads every recorded path that exists in the record's commit, with
///   that commit's content.
/// * Deletes every recorded path that does *not* exist in that commit — the
///   files that deploy had removed.
///
/// # What this cannot do
/// * It does **not** restore what a file looked like before that deploy
///   overwrote it. Rollback is "go back to deploy N", not "undo deploy N". To
///   undo one deploy, roll back to the record before it.
/// * It only touches paths the recorded deploy listed. Files added by *later*
///   deploys are left on the server, so the remote directory is not made
///   byte-identical to the commit. Pass `fullTree` to plan against the whole
///   commit tree instead, which uploads everything but still cannot remove files
///   git never knew about.
/// * It cannot recover content that was never committed. A deploy made with
///   `includeUncommitted` has no recoverable source for those files; such
///   records are rejected unless `force` is set, in which case the committed
///   version is used and may differ from what was shipped.
/// * If the commit is gone from the local repository (force-push, `gc`, or a
///   fresh clone), rollback fails rather than guessing.
/// * File modes, timestamps, and ownership are not restored, and empty remote
///   directories left behind by deletions are not pruned.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn rollback_deploy(
    record_id: String,
    session_id: Option<String>,
    repo_path: Option<String>,
    exclude_patterns: Option<Vec<String>>,
    full_tree: Option<bool>,
    force: Option<bool>,
    dry_run: Option<bool>,
    deploy_id: Option<String>,
    state: State<'_, AppState>,
    window: Window,
) -> AppResult<DeployOutcome> {
    let started = std::time::Instant::now();
    let dry_run = dry_run.unwrap_or(false);
    let full_tree = full_tree.unwrap_or(false);
    let force = force.unwrap_or(false);

    let rid = record_id.clone();
    let record = tokio::task::spawn_blocking(move || deploy_history::get(&rid))
        .await?
        .ok_or_else(|| AppError::not_found(format!("deploy record {record_id}")))?;

    if record
        .error
        .as_deref()
        .is_some_and(|e| e.contains("uncommitted"))
        && !force
    {
        return Err(AppError::config(
            "That deploy included uncommitted changes, so its exact content is not recoverable \
             from git. Re-run with force to roll back to the committed version instead."
                .to_string(),
        ));
    }
    if record.commit_sha.is_empty() {
        return Err(AppError::config(
            "That deploy record has no commit, so there is nothing to roll back to.".to_string(),
        ));
    }

    let repo_path = PathBuf::from(repo_path.unwrap_or_else(|| record.repo_path.clone()));
    if repo_path.as_os_str().is_empty() {
        return Err(AppError::config(
            "That deploy record has no repository path; pass repoPath explicitly.".to_string(),
        ));
    }

    // Resolve the target session: the caller's, or the single live session that
    // matches the record's host, user, and protocol.
    let session_id = match session_id {
        Some(id) => id,
        None => match_session(&state, &record)?,
    };
    let meta = state.session_meta(&session_id).ok_or_else(|| {
        AppError::config(format!(
            "Session '{session_id}' is not connected. Reconnect and try again."
        ))
    })?;

    let deploy_id = deploy_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let cancel = register_cancel(&deploy_id);
    let _cancel_guard = CancelGuard(deploy_id.clone());

    emit_progress(&window, &deploy_id, DeployPhase::Scanning, 0, 0, "", "", 0);

    let excludes = exclude_patterns.unwrap_or_default();
    let commit_sha = record.commit_sha.clone();
    let remote_base = record.remote_base_path.clone();
    let paths: Vec<String> = record
        .files_uploaded
        .iter()
        .chain(record.files_deleted.iter())
        .cloned()
        .collect();

    let plan = {
        let repo_path = repo_path.clone();
        tokio::task::spawn_blocking(move || {
            if full_tree {
                // Whole-tree replay: every file in the commit, no delete set.
                git::plan_deploy(
                    &repo_path,
                    &DeployRequest {
                        rev: commit_sha,
                        base_rev: None,
                        remote_base_path: remote_base,
                        exclude_patterns: excludes,
                        include_uncommitted: false,
                    },
                )
            } else {
                git::plan_rollback(&repo_path, &commit_sha, &remote_base, &paths, &excludes)
            }
        })
        .await??
    };

    if dry_run {
        emit_progress(
            &window,
            &deploy_id,
            DeployPhase::Finished,
            plan.total_operations(),
            plan.total_operations(),
            "",
            "",
            0,
        );
        return Ok(dry_run_outcome(deploy_id, plan, started));
    }

    let session = state.require_session(&session_id)?;
    let outcome = execute_plan(
        &deploy_id, &plan, &session, &repo_path, &window, &cancel, started,
    )
    .await?;

    let record_id = write_history(&meta, &repo_path.to_string_lossy(), &plan, &outcome).await;
    Ok(DeployOutcome {
        record_id,
        ..outcome
    })
}

/// Find the one live session matching a record's target. Ambiguity is an error
/// rather than a coin flip — rolling back onto the wrong server is unrecoverable.
fn match_session(state: &State<'_, AppState>, record: &DeployRecord) -> AppResult<String> {
    let candidates: Vec<SessionMeta> = state
        .list_sessions()
        .into_iter()
        .filter(|m| {
            m.host == record.server_host
                && m.username == record.server_user
                && m.protocol == record.protocol
        })
        .collect();

    match candidates.len() {
        0 => Err(AppError::config(format!(
            "No connected session for {}@{}. Connect to it first, or pass sessionId.",
            record.server_user, record.server_host
        ))),
        1 => Ok(candidates[0].id.clone()),
        n => Err(AppError::config(format!(
            "{n} connected sessions match {}@{}; pass sessionId to choose one.",
            record.server_user, record.server_host
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deploy_args_default_to_a_reproducible_committed_deploy() {
        let args: DeployArgs = serde_json::from_value(serde_json::json!({
            "sessionId": "s1",
            "repoPath": "C:/repo",
            "remoteBasePath": "/var/www"
        }))
        .unwrap();
        assert!(
            !args.include_uncommitted,
            "the dirty worktree must be opt-in"
        );
        assert!(!args.dry_run);
        assert!(args.use_history_base, "history base is the useful default");
        assert!(args.rev.is_none());
        assert!(args.exclude_patterns.is_empty());
    }

    #[test]
    fn deploy_args_accept_camel_case_and_the_legacy_since_ref() {
        let args: DeployArgs = serde_json::from_value(serde_json::json!({
            "sessionId": "s1",
            "repoPath": "C:/repo",
            "remoteBasePath": "/var/www",
            "sinceRef": "v1.0",
            "excludePatterns": ["*.map"],
            "includeUncommitted": true,
            "dryRun": true,
            "deployId": "d1"
        }))
        .unwrap();
        assert_eq!(args.base_rev.as_deref(), Some("v1.0"));
        assert_eq!(args.exclude_patterns, ["*.map"]);
        assert!(args.include_uncommitted);
        assert!(args.dry_run);
        assert_eq!(args.deploy_id.as_deref(), Some("d1"));
    }

    #[test]
    fn progress_payload_is_camel_case() {
        let json = serde_json::to_value(DeployProgress {
            deploy_id: "d1".into(),
            phase: DeployPhase::Uploading,
            current: 2,
            total: 7,
            path: "a/b.txt".into(),
            remote_path: "/var/www/a/b.txt".into(),
            bytes: 1234,
        })
        .unwrap();
        assert_eq!(json["deployId"], "d1");
        assert_eq!(json["phase"], "uploading");
        assert_eq!(json["current"], 2);
        assert_eq!(json["total"], 7);
        assert_eq!(json["remotePath"], "/var/www/a/b.txt");
        assert!(json.get("deploy_id").is_none());
    }

    #[test]
    fn cancelling_an_unknown_deploy_is_an_error_not_a_silent_noop() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let err = rt
            .block_on(cancel_deploy("no-such-deploy".into()))
            .unwrap_err();
        assert_eq!(err.code(), "not_found");
    }

    #[test]
    fn cancel_registry_flags_a_live_deploy() {
        let flag = register_cancel("live-1");
        assert!(!flag.load(Ordering::SeqCst));
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(cancel_deploy("live-1".into())).unwrap();
        assert!(flag.load(Ordering::SeqCst));
        unregister_cancel("live-1");
        assert!(rt.block_on(cancel_deploy("live-1".into())).is_err());
    }

    #[test]
    fn cancel_guard_unregisters_on_drop() {
        {
            let _flag = register_cancel("guarded");
            let _guard = CancelGuard("guarded".into());
            assert!(lock_or_recover(cancels()).contains_key("guarded"));
        }
        assert!(!lock_or_recover(cancels()).contains_key("guarded"));
    }

    #[test]
    fn staging_guard_removes_its_directory() {
        let dir = std::env::temp_dir().join(format!("ftpie-stage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("nested/a.txt"), b"x").unwrap();
        {
            let _guard = StagingGuard(dir.clone());
        }
        assert!(!dir.exists(), "staging must not leak temp files");
    }

    #[test]
    fn outcome_serializes_camel_case() {
        let outcome = DeployOutcome {
            deploy_id: "d".into(),
            dry_run: true,
            plan: serde_json::from_value(serde_json::json!({
                "rev": "HEAD",
                "branch": "main",
                "commitSha": "abc",
                "commit": null,
                "baseCommitSha": null,
                "remoteBasePath": "/w",
                "includeUncommitted": false,
                "uploads": [],
                "deletes": [],
                "skipped": [],
                "totalBytes": 0
            }))
            .unwrap(),
            uploaded: 0,
            deleted: 0,
            failed: 0,
            skipped: 0,
            bytes: 0,
            duration_ms: 5,
            cancelled: false,
            success: true,
            files: vec![FileOutcome {
                path: "a".into(),
                remote_path: "/w/a".into(),
                action: DeployAction::Delete,
                status: OutcomeStatus::Skipped,
                bytes: 0,
                error: None,
            }],
            record_id: None,
        };
        let json = serde_json::to_value(&outcome).unwrap();
        assert_eq!(json["deployId"], "d");
        assert_eq!(json["dryRun"], true);
        assert_eq!(json["durationMs"], 5);
        assert_eq!(json["files"][0]["action"], "delete");
        assert_eq!(json["files"][0]["status"], "skipped");
        assert_eq!(json["files"][0]["remotePath"], "/w/a");
    }
}
