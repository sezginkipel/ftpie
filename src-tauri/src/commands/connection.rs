use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::ftp::{client::FtpSession, ConnectionConfig, Protocol};
use crate::sftp::SftpSession;
use crate::state::{lock_or_recover, AppState, SessionMeta};

/// No `Debug` derive on purpose: this struct carries a plaintext password and key
/// passphrase straight off the IPC boundary, and a single `tracing::debug!(?args)`
/// would put them in the log. Log `ConnectionConfig::target()` instead, or the
/// redacting `Debug` on `ConnectionConfig`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectArgs {
    pub host: String,
    pub port: Option<u16>,
    pub username: String,
    pub password: Option<String>,
    pub protocol: String,
    pub passive_mode: Option<bool>,
    /// SFTP public-key authentication.
    pub private_key_path: Option<String>,
    pub key_passphrase: Option<String>,
    pub connect_timeout_secs: Option<u64>,
    pub io_timeout_secs: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub session: SessionMeta,
    /// True when traffic is encrypted; the UI warns when it is not.
    pub secure: bool,
}

#[tauri::command]
pub async fn connect(args: ConnectArgs, state: State<'_, AppState>) -> AppResult<ConnectResult> {
    let protocol = Protocol::parse(&args.protocol)?;

    if args.host.trim().is_empty() {
        return Err(AppError::config("Host is required".to_string()));
    }

    let defaults = lock_or_recover(&state.settings).clone();
    let config = ConnectionConfig {
        host: args.host.trim().to_string(),
        port: args.port.unwrap_or_else(|| protocol.default_port()),
        username: args.username.clone(),
        password: args.password.clone(),
        protocol,
        passive_mode: args.passive_mode.unwrap_or(true),
        connect_timeout_secs: args
            .connect_timeout_secs
            .unwrap_or(defaults.connect_timeout_secs),
        io_timeout_secs: args.io_timeout_secs.unwrap_or(defaults.io_timeout_secs),
        private_key_path: args.private_key_path.clone(),
        key_passphrase: args.key_passphrase.clone(),
    };

    // Backstop only. The real protection is the per-socket connect and IO
    // timeouts inside the protocol layer; the old code relied on an outer
    // timeout alone, which abandoned the blocking task and leaked the socket.
    let budget =
        std::time::Duration::from_secs(config.connect_timeout_secs + config.io_timeout_secs + 10);
    let target = config.target();

    let meta = match protocol {
        Protocol::Sftp => {
            let trust = Arc::clone(&state.trust);
            let fut = SftpSession::connect(config, trust);
            let session = tokio::time::timeout(budget, fut)
                .await
                .map_err(|_| AppError::timeout(format!("Connection to {target} timed out")))??;
            state.add_sftp_session(session)
        }
        _ => {
            let trust = Arc::clone(&state.trust);
            let join = tokio::task::spawn_blocking(move || FtpSession::connect(config, &trust));
            let session = tokio::time::timeout(budget, join)
                .await
                .map_err(|_| AppError::timeout(format!("Connection to {target} timed out")))???;
            state.add_ftp_session(session)
        }
    };

    tracing::info!(
        session = %meta.id,
        host = %meta.host,
        port = meta.port,
        protocol = %meta.protocol,
        "session established"
    );

    Ok(ConnectResult {
        secure: protocol.is_secure(),
        session: meta,
    })
}

#[tauri::command]
pub async fn disconnect(session_id: String, state: State<'_, AppState>) -> AppResult<()> {
    match state.remove_session(&session_id) {
        Some(entry) => {
            let meta = entry.meta.clone();
            // Say goodbye properly (FTP QUIT / SSH disconnect) instead of just
            // dropping the socket, which is all the old implementation did.
            entry.kind.close().await;
            tracing::info!(session = %meta.id, host = %meta.host, "session closed");
            Ok(())
        }
        // Disconnecting something already gone is not an error; the UI should
        // still be able to drop the tab. The previous implementation could
        // leave a tab stuck forever when the socket was already dead.
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> AppResult<Vec<SessionMeta>> {
    Ok(state.list_sessions())
}
