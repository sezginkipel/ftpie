use crate::ftp::{client::FtpSession, types::ConnectionConfig, Protocol};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Deserialize)]
pub struct ConnectArgs {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub protocol: String,
    pub passive_mode: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct ConnectResult {
    pub session_id: String,
    pub server_welcome: Option<String>,
}

#[tauri::command]
pub async fn connect(
    args: ConnectArgs,
    state: State<'_, AppState>,
) -> Result<ConnectResult, String> {
    let protocol = parse_protocol(&args.protocol)?;

    let config = ConnectionConfig {
        host: args.host.clone(),
        port: args.port,
        username: args.username.clone(),
        password: args.password.clone(),
        protocol: protocol.clone(),
        passive_mode: args.passive_mode.unwrap_or(true),
        timeout_secs: 30,
    };

    // Blocking işlem — spawn_blocking içinde çalıştır
    let session = tokio::task::spawn_blocking(move || FtpSession::connect(config))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let session_id = state.add_session(session);

    tracing::info!(session_id = %session_id, host = %args.host, "session created");
    Ok(ConnectResult {
        session_id,
        server_welcome: None,
    })
}

#[tauri::command]
pub async fn disconnect(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session_arc = state
        .get_session(&session_id)
        .ok_or_else(|| format!("session not found: {}", session_id))?;

    tokio::task::spawn_blocking(move || {
        let mut session = session_arc.lock().unwrap();
        session.disconnect().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    state.remove_session(&session_id);
    tracing::info!(session_id = %session_id, "session closed");
    Ok(())
}

fn parse_protocol(s: &str) -> Result<Protocol, String> {
    match s {
        "ftp" => Ok(Protocol::Ftp),
        "ftps" => Ok(Protocol::Ftps),
        "ftps_implicit" => Ok(Protocol::FtpsImplicit),
        "sftp" => Ok(Protocol::Sftp),
        "webdav" => Ok(Protocol::WebDav),
        "s3" => Ok(Protocol::S3),
        _ => Err(format!("unknown protocol: {}", s)),
    }
}
