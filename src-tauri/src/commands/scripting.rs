//! Automation-script commands.
//!
//! The Rhai engine is sandboxed in `crate::scripting` (bounded operations, no
//! environment access, filesystem confined to the script workspace). This module
//! supplies the bridge that lets a script drive a real session, replacing the
//! old `ftp_connect` stub that returned a map containing the password and did
//! nothing at all.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::ftp::RemoteFile;
use crate::scripting::{Script, ScriptHost, ScriptRun};
use crate::state::{lock_or_recover, AppState, SessionKind};
use crate::transfer::TransferCtl;

/// Adapts an async session to the synchronous interface the script engine needs.
///
/// Scripts run on a blocking thread (`spawn_blocking`), so blocking on the
/// session's futures here is safe — it never occupies an async worker.
struct SessionScriptHost {
    session: SessionKind,
    /// Shared with the engine's interrupt flag, so `cancel_script` also aborts a
    /// transfer already in flight. Rhai's progress callback cannot interrupt a
    /// blocking host call, so without this a cancel during a multi-gigabyte
    /// `ftp_download` would wait for the whole file.
    cancel: Arc<AtomicBool>,
}

impl SessionScriptHost {
    fn ctl(&self) -> TransferCtl {
        TransferCtl::new(Arc::clone(&self.cancel), Arc::new(|_| {}))
    }
}

impl ScriptHost for SessionScriptHost {
    fn list(&self, path: &str) -> AppResult<Vec<RemoteFile>> {
        tauri::async_runtime::block_on(self.session.list(path))
    }

    fn download(&self, remote: &str, local: &str) -> AppResult<u64> {
        let local = std::path::PathBuf::from(local);
        tauri::async_runtime::block_on(self.session.download_to_local(remote, local, &self.ctl()))
    }

    fn upload(&self, local: &str, remote: &str) -> AppResult<u64> {
        let local = std::path::PathBuf::from(local);
        tauri::async_runtime::block_on(self.session.upload_local(local, remote, &self.ctl()))
    }

    fn mkdir(&self, path: &str) -> AppResult<()> {
        tauri::async_runtime::block_on(self.session.mkdir_all(path))
    }

    fn delete(&self, path: &str) -> AppResult<()> {
        tauri::async_runtime::block_on(self.session.delete_file(path))
    }

    fn log(&self, message: &str) {
        tracing::info!(target: "ftpie::script", "{message}");
    }
}

#[tauri::command]
pub async fn list_scripts(state: State<'_, AppState>) -> AppResult<Vec<Script>> {
    Ok(lock_or_recover(&state.scripts).list().to_vec())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveScriptArgs {
    /// Absent for a new script.
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub source: String,
}

#[tauri::command]
pub async fn save_script(args: SaveScriptArgs, state: State<'_, AppState>) -> AppResult<Script> {
    if args.name.trim().is_empty() {
        return Err(AppError::config("A script needs a name".to_string()));
    }

    // One lock across read-modify-write; the old commands re-read the store from
    // disk on every call and raced with each other.
    let mut store = lock_or_recover(&state.scripts);

    let script = match args.id {
        Some(id) => {
            let mut existing = store
                .get(&id)
                .cloned()
                .ok_or_else(|| AppError::not_found(&id))?;
            existing.name = args.name.trim().to_string();
            existing.description = args.description;
            existing.source = args.source;
            existing
        }
        None => {
            let mut fresh = Script::new(args.name.trim(), args.source);
            fresh.description = args.description;
            fresh
        }
    };

    store.upsert(script.clone())?;
    Ok(script)
}

#[tauri::command]
pub async fn delete_script(id: String, state: State<'_, AppState>) -> AppResult<()> {
    let mut store = lock_or_recover(&state.scripts);
    if !store.delete(&id)? {
        return Err(AppError::not_found(&id));
    }
    Ok(())
}

#[tauri::command]
pub async fn validate_script(source: String) -> AppResult<()> {
    crate::scripting::validate_script(&source)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunScriptArgs {
    /// Session the script's remote calls act on. Scripts that only touch the
    /// workspace may omit it.
    pub session_id: Option<String>,
    /// Run a stored script by id, or...
    pub script_id: Option<String>,
    /// ...run an unsaved buffer directly.
    pub source: Option<String>,
    /// Caller-generated handle so the run can be cancelled while it is going.
    pub run_id: String,
}

#[tauri::command]
pub async fn run_script(args: RunScriptArgs, state: State<'_, AppState>) -> AppResult<ScriptRun> {
    let cancel = Arc::new(AtomicBool::new(false));
    lock_or_recover(&state.script_cancels).insert(args.run_id.clone(), Arc::clone(&cancel));

    // The host shares the engine's cancellation flag so a cancel reaches a
    // transfer that is already running, not just the script's next statement.
    let host: Arc<dyn ScriptHost> = match args.session_id.as_deref() {
        Some(id) => Arc::new(SessionScriptHost {
            session: state.require_session(id)?,
            cancel: Arc::clone(&cancel),
        }),
        None => Arc::new(crate::scripting::NoopHost),
    };

    let scripts = Arc::clone(&state.scripts);
    let script_id = args.script_id.clone();
    let source = args.source.clone();

    let outcome = tokio::task::spawn_blocking(move || match (script_id, source) {
        (Some(id), _) => crate::scripting::run_stored_script(&scripts, &id, host, cancel),
        (None, Some(source)) => crate::scripting::run_script(&source, host, cancel),
        (None, None) => Err(AppError::config(
            "Provide either a saved script id or script source".to_string(),
        )),
    })
    .await;

    // Always drop the cancellation handle, success or failure, so the map does
    // not grow for the life of the process.
    lock_or_recover(&state.script_cancels).remove(&args.run_id);

    outcome?
}

/// Ask a running script to stop. The engine checks the flag from its progress
/// callback, so even an infinite loop terminates instead of pinning a thread.
#[tauri::command]
pub async fn cancel_script(run_id: String, state: State<'_, AppState>) -> AppResult<()> {
    let flag = lock_or_recover(&state.script_cancels).get(&run_id).cloned();
    match flag {
        Some(flag) => {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
            Ok(())
        }
        // Already finished; nothing to cancel.
        None => Ok(()),
    }
}
