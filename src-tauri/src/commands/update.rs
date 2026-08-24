//! Signed auto-update.
//!
//! Two commands, and a hard rule between them: **checking is automatic,
//! installing never is.** `update_check` may run on startup; `update_install`
//! only ever runs because the user clicked Install. An updater that installs on
//! its own is a remote code execution channel wearing a progress bar.
//!
//! Trust comes from `plugins.updater.pubkey` in `tauri.conf.json`: the plugin
//! verifies the minisign signature of every downloaded artifact against that
//! key before touching the installed app. A tampered or unsigned artifact is
//! rejected here, in Rust, and surfaces as `AppError::Protocol`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use crate::error::{AppError, AppResult};

/// Emitted on `update:progress` while an update downloads.
pub const PROGRESS_EVENT: &str = "update:progress";

/// A release newer than the running build.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// Version offered by the manifest, e.g. `0.2.0`.
    pub version: String,
    /// Version currently running, so the UI can render "0.1.0 → 0.2.0".
    pub current_version: String,
    /// Release notes from the manifest. Plain text; the UI must not treat it as
    /// markup — it comes off the network.
    pub notes: Option<String>,
    /// Publication date as the manifest stated it. Free-form, so the frontend
    /// renders it as-is rather than parsing it.
    pub pub_date: Option<String>,
}

/// Payload of `update:progress`. `total` is absent when the server sends no
/// `Content-Length` — the UI must then show an indeterminate bar rather than
/// invent a percentage.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// Map a plugin failure onto the app's error vocabulary.
///
/// The plugin's error enum is `#[non_exhaustive]` and its variants churn between
/// patch releases, so this classifies on the rendered message instead of
/// matching variants — a match would compile today and break on the next bump.
/// What matters is that the frontend's existing `code` mapping keeps working:
/// a signature failure must never look like a generic internal error.
fn map_err(e: tauri_plugin_updater::Error) -> AppError {
    let message = e.to_string();
    let hay = message.to_lowercase();

    let signature = hay.contains("signature")
        || hay.contains("minisign")
        || hay.contains("pubkey")
        || hay.contains("public key")
        || hay.contains("untrusted comment");
    if signature {
        return AppError::protocol(format!(
            "the update could not be verified against the release signing key: {message}"
        ));
    }

    if hay.contains("timed out") || hay.contains("timeout") {
        return AppError::timeout(format!("the update server did not respond: {message}"));
    }

    let network = hay.contains("network")
        || hay.contains("dns")
        || hay.contains("connect")
        || hay.contains("tls")
        || hay.contains("certificate")
        || hay.contains("http")
        || hay.contains("url")
        || hay.contains("endpoint");
    if network {
        return AppError::net(format!("the update server is unreachable: {message}"));
    }

    if hay.contains("permission") || hay.contains("denied") || hay.contains("access is denied") {
        return AppError::permission(format!(
            "the update could not be written to disk: {message}"
        ));
    }

    if hay.contains("io error") || hay.contains("no such file") || hay.contains("os error") {
        return AppError::io(message);
    }

    // A missing or malformed `plugins.updater` block, and a manifest whose JSON
    // does not parse, are both configuration faults rather than app bugs.
    if hay.contains("config") || hay.contains("json") || hay.contains("semver") {
        return AppError::config(format!("the update manifest could not be read: {message}"));
    }

    AppError::internal(format!("update failed: {message}"))
}

/// Ask the configured endpoint whether a newer signed release exists.
///
/// `Ok(None)` means "you are up to date" — that is the ordinary outcome, not an
/// error, and the UI shows nothing for it.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> AppResult<Option<UpdateInfo>> {
    let update = check(&app).await?;

    Ok(update.map(|update| UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
        pub_date: update.date.map(|date| date.to_string()),
    }))
}

/// Download, verify, install, and relaunch.
///
/// The check is repeated here rather than caching the `Update` handle from
/// `update_check`: the handle is not `Send`-friendly to park in app state, and
/// re-checking means a manifest that changed (or a signature that was revoked)
/// between the banner appearing and the click is honoured.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> AppResult<()> {
    let Some(update) = check(&app).await? else {
        // Not a network fault and not a bug: the release was pulled, or another
        // window installed it first.
        return Err(AppError::config(
            "there is no update to install — you are already on the latest release".to_string(),
        ));
    };

    let downloaded = Arc::new(AtomicU64::new(0));

    let on_chunk = {
        let app = app.clone();
        let downloaded = Arc::clone(&downloaded);
        move |chunk: usize, total: Option<u64>| {
            let done = downloaded.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
            // A dropped progress tick must never abort a download in flight.
            let _ = app.emit(
                PROGRESS_EVENT,
                UpdateProgress {
                    downloaded: done,
                    total,
                },
            );
        }
    };

    let on_finish = {
        let app = app.clone();
        let downloaded = Arc::clone(&downloaded);
        move || {
            let done = downloaded.load(Ordering::Relaxed);
            let _ = app.emit(
                PROGRESS_EVENT,
                UpdateProgress {
                    downloaded: done,
                    total: Some(done),
                },
            );
        }
    };

    update
        .download_and_install(on_chunk, on_finish)
        .await
        .map_err(map_err)?;

    tracing::info!(version = %update.version, "update installed, relaunching");

    // `AppHandle::restart` is exactly what `tauri_plugin_process`'s `restart`
    // command calls; going through it keeps the relaunch on the plugin's
    // supported path while staying in Rust. It does not return.
    app.restart();
}

/// Shared half of both commands.
async fn check(app: &AppHandle) -> AppResult<Option<tauri_plugin_updater::Update>> {
    let updater = app.updater().map_err(map_err)?;
    updater.check().await.map_err(map_err)
}
