use tauri::State;

use crate::error::{AppResult, TrustKind};
use crate::state::{lock_or_recover, AppState};
use crate::trust::TrustEntry;

#[tauri::command]
pub async fn list_trusted_hosts(state: State<'_, AppState>) -> AppResult<Vec<TrustEntry>> {
    Ok(lock_or_recover(&state.trust).list())
}

/// Pin a host identity the user has just verified out of band.
///
/// This is the second half of the trust-on-first-use flow: a connect attempt
/// against an unknown host fails with `AppError::UntrustedHost` carrying the
/// fingerprint, the UI shows it, and the user's confirmation lands here before
/// the connect is retried.
#[tauri::command]
pub async fn trust_host(
    host: String,
    port: u16,
    kind: TrustKind,
    fingerprint: String,
    algorithm: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let entry = TrustEntry {
        host,
        port,
        kind,
        algorithm,
        fingerprint,
        added_at: chrono::Utc::now(),
    };
    lock_or_recover(&state.trust).trust(entry)
}

#[tauri::command]
pub async fn forget_trusted_host(
    host: String,
    port: u16,
    kind: TrustKind,
    state: State<'_, AppState>,
) -> AppResult<()> {
    lock_or_recover(&state.trust).forget(&host, port, kind)
}
