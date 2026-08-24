use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::state::{lock_or_recover, AppState};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreHealth {
    /// A store whose file could not be parsed is quarantined as
    /// `<name>.corrupt-<timestamp>` and comes up empty **and read-only**, so a
    /// later save cannot overwrite recoverable user data. The UI must tell the
    /// user, otherwise their bookmarks appear to have silently vanished.
    pub bookmarks_ok: bool,
    pub scripts_ok: bool,
    pub trusted_hosts_ok: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    /// Where bookmarks, the vault verifier and known_hosts live.
    pub config_dir: String,
    pub stores: StoreHealth,
}

/// The status bar used to hard-code "ftpie v0.1.0"; it now reads the real
/// package version so a release cannot ship a stale number.
#[tauri::command]
pub async fn app_version(state: State<'_, AppState>) -> AppResult<AppInfo> {
    let stores = StoreHealth {
        bookmarks_ok: !lock_or_recover(&state.bookmarks).load_failed,
        scripts_ok: !lock_or_recover(&state.scripts).load_failed,
        trusted_hosts_ok: !lock_or_recover(&state.trust).load_failed(),
    };

    Ok(AppInfo {
        name: "ftpie".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        config_dir: crate::store_util::config_dir()
            .to_string_lossy()
            .to_string(),
        stores,
    })
}
