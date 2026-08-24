use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::bookmarks::BookmarkStore;
use crate::error::{AppError, AppResult};
use crate::ftp::{ConnectionConfig, FtpSession, Protocol, RemoteFile};
use crate::scripting::ScriptStore;
use crate::sftp::SftpSession;
use crate::transfer::{TransferCtl, TransferManager};
use crate::trust::TrustStore;
use crate::vault::Vault;

/// Cap on recursion while deleting a remote directory tree. The listing that
/// drives the walk comes from the server, so the depth is not ours to trust.
const MAX_DELETE_DEPTH: usize = 64;

/// Take a lock without panicking when a previous holder panicked.
///
/// Every `Mutex` in this crate guards plain data, so a poisoned lock only means
/// "someone panicked while holding it", not "the data is unusable". The old code
/// called `.lock().unwrap()` in ~30 places, so a single panic anywhere turned
/// every later command into a panic as well.
pub fn lock_or_recover<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    match m.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            tracing::warn!("recovering from a poisoned mutex");
            poisoned.into_inner()
        }
    }
}

/// Identity of a live session, cached so callers never need the session lock
/// just to learn where they are connected.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub protocol: Protocol,
}

impl SessionMeta {
    fn from_config(id: &str, config: &ConnectionConfig) -> Self {
        Self {
            id: id.to_string(),
            host: config.host.clone(),
            port: config.port,
            username: config.username.clone(),
            protocol: config.protocol,
        }
    }
}

/// A live connection, unified across the sync FTP and async SFTP backends.
#[derive(Clone)]
pub enum SessionKind {
    /// Synchronous FTP (suppaftp); every call runs in `spawn_blocking`.
    Ftp(Arc<Mutex<FtpSession>>),
    /// Asynchronous SFTP (russh + russh-sftp).
    Sftp(Arc<tokio::sync::Mutex<SftpSession>>),
}

/// Run a closure against the FTP session on a blocking thread.
macro_rules! ftp_blocking {
    ($arc:expr, |$s:ident| $body:expr) => {{
        let arc = $arc.clone();
        tokio::task::spawn_blocking(move || {
            let mut $s = lock_or_recover(&arc);
            $body
        })
        .await?
    }};
}

impl SessionKind {
    pub async fn list(&self, path: &str) -> AppResult<Vec<RemoteFile>> {
        match self {
            SessionKind::Ftp(ftp) => {
                let p = path.to_string();
                ftp_blocking!(ftp, |s| s.list(&p))
            }
            SessionKind::Sftp(sftp) => sftp.lock().await.list(path).await,
        }
    }

    pub async fn read_file_bytes(&self, remote_path: &str) -> AppResult<Vec<u8>> {
        match self {
            SessionKind::Ftp(ftp) => {
                let p = remote_path.to_string();
                ftp_blocking!(ftp, |s| s.read_file_bytes(&p))
            }
            SessionKind::Sftp(sftp) => sftp.lock().await.read_file_bytes(remote_path).await,
        }
    }

    pub async fn write_file_bytes(&self, remote_path: &str, data: Vec<u8>) -> AppResult<u64> {
        match self {
            SessionKind::Ftp(ftp) => {
                let p = remote_path.to_string();
                ftp_blocking!(ftp, |s| s.write_file_bytes(&p, &data))
            }
            SessionKind::Sftp(sftp) => sftp.lock().await.write_file_bytes(remote_path, &data).await,
        }
    }

    pub async fn upload_local(
        &self,
        local_path: PathBuf,
        remote_path: &str,
        ctl: &TransferCtl,
    ) -> AppResult<u64> {
        match self {
            SessionKind::Ftp(ftp) => {
                let rp = remote_path.to_string();
                let ctl = ctl.clone();
                ftp_blocking!(ftp, |s| s.upload_local(&local_path, &rp, &ctl))
            }
            SessionKind::Sftp(sftp) => {
                sftp.lock()
                    .await
                    .upload_local(&local_path, remote_path, ctl)
                    .await
            }
        }
    }

    pub async fn download_to_local(
        &self,
        remote_path: &str,
        local_path: PathBuf,
        ctl: &TransferCtl,
    ) -> AppResult<u64> {
        match self {
            SessionKind::Ftp(ftp) => {
                let rp = remote_path.to_string();
                let ctl = ctl.clone();
                ftp_blocking!(ftp, |s| s.download_to_local(&rp, &local_path, &ctl))
            }
            SessionKind::Sftp(sftp) => {
                sftp.lock()
                    .await
                    .download_to_local(remote_path, &local_path, ctl)
                    .await
            }
        }
    }

    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        match self {
            SessionKind::Ftp(ftp) => {
                let p = path.to_string();
                ftp_blocking!(ftp, |s| s.mkdir(&p))
            }
            SessionKind::Sftp(sftp) => sftp.lock().await.mkdir(path).await,
        }
    }

    /// Create a directory and every missing parent. Plain FTP `MKD` is not
    /// recursive, which is why deploys to a fresh nested path used to fail.
    pub async fn mkdir_all(&self, path: &str) -> AppResult<()> {
        match self {
            SessionKind::Ftp(ftp) => {
                let p = path.to_string();
                ftp_blocking!(ftp, |s| s.mkdir_all(&p))
            }
            SessionKind::Sftp(sftp) => sftp.lock().await.mkdir_all(path).await,
        }
    }

    pub async fn delete_file(&self, path: &str) -> AppResult<()> {
        match self {
            SessionKind::Ftp(ftp) => {
                let p = path.to_string();
                ftp_blocking!(ftp, |s| s.delete_file(&p))
            }
            SessionKind::Sftp(sftp) => sftp.lock().await.delete_file(path).await,
        }
    }

    pub async fn delete_dir(&self, path: &str) -> AppResult<()> {
        match self {
            SessionKind::Ftp(ftp) => {
                let p = path.to_string();
                ftp_blocking!(ftp, |s| s.delete_dir(&p))
            }
            SessionKind::Sftp(sftp) => sftp.lock().await.delete_dir(path).await,
        }
    }

    /// Remove a directory and everything under it, deepest entries first.
    ///
    /// Symlinked directories are unlinked rather than followed, so a remote
    /// `loop -> .` cannot send this into recursion. A depth cap is still needed on
    /// top of that: a server is free to report a genuine (non-symlink)
    /// subdirectory at every level forever, which would recurse until the process
    /// ran out of memory — and unlike a download, every level here issues
    /// *deletes* with the user's credentials.
    ///
    /// Boxed because an `async fn` cannot recurse into itself directly.
    pub fn delete_dir_recursive<'a>(
        &'a self,
        path: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<()>> + Send + 'a>> {
        self.delete_dir_recursive_at(path, 0)
    }

    fn delete_dir_recursive_at<'a>(
        &'a self,
        path: &'a str,
        depth: usize,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<()>> + Send + 'a>> {
        Box::pin(async move {
            if depth > MAX_DELETE_DEPTH {
                return Err(AppError::config(format!(
                    "refusing to recurse deeper than {MAX_DELETE_DEPTH} levels while \
                     deleting {path}"
                )));
            }
            let entries = self.list(path).await?;
            for entry in entries {
                if entry.is_dir && !entry.is_symlink {
                    self.delete_dir_recursive_at(&entry.path, depth + 1).await?;
                } else {
                    self.delete_file(&entry.path).await?;
                }
            }
            self.delete_dir(path).await
        })
    }

    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        match self {
            SessionKind::Ftp(ftp) => {
                let f = from.to_string();
                let t = to.to_string();
                ftp_blocking!(ftp, |s| s.rename(&f, &t))
            }
            SessionKind::Sftp(sftp) => sftp.lock().await.rename(from, to).await,
        }
    }

    pub async fn chmod(&self, path: &str, mode: u32) -> AppResult<()> {
        match self {
            SessionKind::Ftp(ftp) => {
                let p = path.to_string();
                ftp_blocking!(ftp, |s| s.chmod(&p, mode))
            }
            SessionKind::Sftp(sftp) => sftp.lock().await.chmod(path, mode).await,
        }
    }

    pub async fn size(&self, path: &str) -> AppResult<u64> {
        match self {
            SessionKind::Ftp(ftp) => {
                let p = path.to_string();
                ftp_blocking!(ftp, |s| s.size(&p))
            }
            SessionKind::Sftp(sftp) => sftp.lock().await.size(path).await,
        }
    }

    /// Close the connection politely, sending FTP `QUIT` or an SSH disconnect
    /// instead of just dropping the socket.
    ///
    /// Only the last handle can shut the session down, so if a transfer is still
    /// holding a clone this falls back to dropping — the socket still closes, the
    /// server just does not get the courtesy notice.
    pub async fn close(self) {
        match self {
            SessionKind::Ftp(arc) => match Arc::try_unwrap(arc) {
                Ok(mutex) => {
                    let session = mutex.into_inner().unwrap_or_else(|e| e.into_inner());
                    let _ = tokio::task::spawn_blocking(move || session.quit()).await;
                }
                Err(_) => tracing::debug!("FTP session still in use; closing without QUIT"),
            },
            SessionKind::Sftp(arc) => match Arc::try_unwrap(arc) {
                Ok(mutex) => {
                    if let Err(e) = mutex.into_inner().disconnect().await {
                        tracing::debug!(error = %e, "SFTP disconnect reported an error");
                    }
                }
                Err(_) => tracing::debug!("SFTP session still in use; closing without goodbye"),
            },
        }
    }

    /// Cheap liveness probe used by the keepalive task.
    ///
    /// Uses `try_lock` so the probe is skipped rather than queued behind an
    /// in-flight transfer — a busy session is self-evidently alive.
    pub async fn keepalive(&self) -> AppResult<()> {
        match self {
            SessionKind::Ftp(ftp) => {
                let ftp = ftp.clone();
                tokio::task::spawn_blocking(move || match ftp.try_lock() {
                    Ok(mut s) => s.noop(),
                    Err(_) => Ok(()),
                })
                .await?
            }
            SessionKind::Sftp(sftp) => match sftp.try_lock() {
                Ok(s) => s.keepalive().await,
                Err(_) => Ok(()),
            },
        }
    }
}

// ── Application state ────────────────────────────────────────────────────────

pub struct SessionEntry {
    pub kind: SessionKind,
    pub meta: SessionMeta,
}

/// Backend-side settings that must be honoured by Rust, not just displayed.
#[derive(Debug, Clone)]
pub struct BackendSettings {
    pub max_concurrent_transfers: usize,
    pub connect_timeout_secs: u64,
    pub io_timeout_secs: u64,
    pub keepalive_secs: u64,
}

impl Default for BackendSettings {
    fn default() -> Self {
        Self {
            max_concurrent_transfers: 3,
            connect_timeout_secs: 15,
            io_timeout_secs: 60,
            keepalive_secs: 60,
        }
    }
}

pub struct AppState {
    pub sessions: Mutex<HashMap<String, SessionEntry>>,
    /// `Arc` because the Argon2 work behind a master-password change has to move
    /// into `spawn_blocking`, and re-keying touches the bookmark store.
    pub bookmarks: Arc<Mutex<BookmarkStore>>,
    pub scripts: Arc<Mutex<ScriptStore>>,
    pub trust: Arc<Mutex<TrustStore>>,
    pub vault: Arc<Mutex<Vault>>,
    pub transfers: Arc<TransferManager>,
    pub settings: Mutex<BackendSettings>,
    /// Cancellation flags for running scripts, keyed by script id.
    pub script_cancels: Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
}

impl AppState {
    pub fn new() -> Self {
        let settings = BackendSettings::default();
        Self {
            sessions: Mutex::new(HashMap::new()),
            // A store that fails to load starts empty *and* read-only, so a
            // corrupt file is never overwritten by the next save.
            bookmarks: Arc::new(Mutex::new(BookmarkStore::load())),
            scripts: Arc::new(Mutex::new(ScriptStore::load())),
            trust: Arc::new(Mutex::new(TrustStore::load())),
            vault: Arc::new(Mutex::new(Vault::load())),
            transfers: Arc::new(TransferManager::new(settings.max_concurrent_transfers)),
            settings: Mutex::new(settings),
            script_cancels: Mutex::new(HashMap::new()),
        }
    }

    pub fn get_session(&self, id: &str) -> Option<SessionKind> {
        lock_or_recover(&self.sessions)
            .get(id)
            .map(|e| e.kind.clone())
    }

    pub fn require_session(&self, id: &str) -> AppResult<SessionKind> {
        self.get_session(id).ok_or_else(|| {
            AppError::config(format!(
                "Session '{id}' is not connected. Reconnect and try again."
            ))
        })
    }

    pub fn session_meta(&self, id: &str) -> Option<SessionMeta> {
        lock_or_recover(&self.sessions)
            .get(id)
            .map(|e| e.meta.clone())
    }

    pub fn list_sessions(&self) -> Vec<SessionMeta> {
        let mut out: Vec<_> = lock_or_recover(&self.sessions)
            .values()
            .map(|e| e.meta.clone())
            .collect();
        out.sort_by(|a, b| a.host.cmp(&b.host).then(a.username.cmp(&b.username)));
        out
    }

    pub fn add_ftp_session(&self, session: FtpSession) -> SessionMeta {
        let id = uuid::Uuid::new_v4().to_string();
        let meta = SessionMeta::from_config(&id, session.config());
        let entry = SessionEntry {
            kind: SessionKind::Ftp(Arc::new(Mutex::new(session))),
            meta: meta.clone(),
        };
        lock_or_recover(&self.sessions).insert(id, entry);
        meta
    }

    pub fn add_sftp_session(&self, session: SftpSession) -> SessionMeta {
        let id = uuid::Uuid::new_v4().to_string();
        let meta = SessionMeta::from_config(&id, session.config());
        let entry = SessionEntry {
            kind: SessionKind::Sftp(Arc::new(tokio::sync::Mutex::new(session))),
            meta: meta.clone(),
        };
        lock_or_recover(&self.sessions).insert(id, entry);
        meta
    }

    /// Remove a session and stop anything still queued against it.
    ///
    /// Returns the entry so the caller can close the connection politely; the
    /// queue is cancelled first so no worker is still holding a handle.
    pub fn remove_session(&self, id: &str) -> Option<SessionEntry> {
        self.transfers.cancel_session(id);
        lock_or_recover(&self.sessions).remove(id)
    }

    /// Drain every session, for shutdown.
    pub fn take_all_sessions(&self) -> Vec<SessionEntry> {
        lock_or_recover(&self.sessions)
            .drain()
            .map(|(_, e)| e)
            .collect()
    }

    pub fn all_sessions(&self) -> Vec<(String, SessionKind)> {
        lock_or_recover(&self.sessions)
            .iter()
            .map(|(id, e)| (id.clone(), e.kind.clone()))
            .collect()
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

/// Periodically probe idle sessions so servers do not silently drop the control
/// connection while the user is reading a directory listing. FTP servers
/// typically close an idle control channel after a few minutes, and the old code
/// only found out when the next operation failed.
pub fn spawn_keepalive(app: tauri::AppHandle) {
    use tauri::Manager;

    // Read the interval before entering the task: `State` borrows the handle, and
    // holding that borrow across an await is what the compiler rejects.
    let interval_secs = lock_or_recover(&app.state::<AppState>().settings)
        .keepalive_secs
        .max(15);

    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
        ticker.tick().await; // the first tick fires immediately; skip it

        loop {
            ticker.tick().await;
            let sessions = app.state::<AppState>().all_sessions();
            for (id, session) in sessions {
                if let Err(e) = session.keepalive().await {
                    tracing::info!(
                        session = %id,
                        error = %e,
                        "keepalive failed; session may be dead"
                    );
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_or_recover_survives_a_poisoned_mutex() {
        let m = Arc::new(Mutex::new(5u32));
        let m2 = Arc::clone(&m);
        // Poison the mutex by panicking while it is held.
        let _ = std::thread::spawn(move || {
            let _guard = m2.lock().unwrap();
            panic!("intentional");
        })
        .join();

        assert!(m.lock().is_err(), "mutex should be poisoned");
        assert_eq!(*lock_or_recover(&m), 5, "recovery must still see the data");
    }

    #[test]
    fn session_meta_is_derived_from_config() {
        let cfg = ConnectionConfig {
            host: "example.com".into(),
            port: 2222,
            username: "deploy".into(),
            protocol: Protocol::Sftp,
            ..Default::default()
        };
        let meta = SessionMeta::from_config("abc", &cfg);
        assert_eq!(meta.id, "abc");
        assert_eq!(meta.host, "example.com");
        assert_eq!(meta.port, 2222);
        assert_eq!(meta.username, "deploy");
        assert_eq!(meta.protocol, Protocol::Sftp);
    }

    #[test]
    fn session_meta_serializes_camel_case() {
        let cfg = ConnectionConfig::default();
        let meta = SessionMeta::from_config("id", &cfg);
        let json = serde_json::to_value(&meta).unwrap();
        assert!(json.get("protocol").is_some());
        assert_eq!(json["id"], "id");
    }
}
