use crate::ftp::{client::FtpSession, types::ConnectionConfig, Protocol};
use crate::sftp::SftpSession;
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
    /// SSH özel anahtar yolu (opsiyonel, SFTP için)
    pub private_key_path: Option<String>,
    pub key_passphrase: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ConnectResult {
    pub session_id: String,
    pub server_welcome: Option<String>,
    pub protocol: String,
}

#[tauri::command]
pub async fn connect(
    args: ConnectArgs,
    state: State<'_, AppState>,
) -> Result<ConnectResult, String> {
    let protocol = parse_protocol(&args.protocol)?;

    match protocol {
        Protocol::Sftp => connect_sftp(args, state).await,
        _ => connect_ftp(args, state, protocol).await,
    }
}

async fn connect_ftp(
    args: ConnectArgs,
    state: State<'_, AppState>,
    protocol: Protocol,
) -> Result<ConnectResult, String> {
    let timeout_secs = 20u64;
    let config = ConnectionConfig {
        host: args.host.clone(),
        port: args.port,
        username: args.username.clone(),
        password: args.password.clone(),
        protocol,
        passive_mode: args.passive_mode.unwrap_or(true),
        timeout_secs,
    };

    let session = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        tokio::task::spawn_blocking(move || FtpSession::connect(config)),
    )
    .await
    .map_err(|_| format!("FTP bağlantı zaman aşımı: {}:{}", args.host, args.port))?
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let session_id = state.add_ftp_session(session);
    tracing::info!(session_id = %session_id, host = %args.host, protocol = %args.protocol, "FTP oturumu oluşturuldu");

    Ok(ConnectResult {
        session_id,
        server_welcome: None,
        protocol: args.protocol,
    })
}

async fn connect_sftp(
    args: ConnectArgs,
    state: State<'_, AppState>,
) -> Result<ConnectResult, String> {
    let timeout_secs = 20u64;
    let config = ConnectionConfig {
        host: args.host.clone(),
        port: args.port,
        username: args.username.clone(),
        password: args.password.clone(),
        protocol: Protocol::Sftp,
        passive_mode: false,
        timeout_secs,
    };

    let session = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        SftpSession::connect(config),
    )
    .await
    .map_err(|_| format!("SFTP bağlantı zaman aşımı: {}:{}", args.host, args.port))?
    .map_err(|e| e.to_string())?;

    let session_id = state.add_sftp_session(session);
    tracing::info!(session_id = %session_id, host = %args.host, "SFTP oturumu oluşturuldu");

    Ok(ConnectResult {
        session_id,
        server_welcome: None,
        protocol: "sftp".to_string(),
    })
}

#[tauri::command]
pub async fn disconnect(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Oturumu state'den çıkar (Arc drop → bağlantı kapanır)
    state.remove_session(&session_id);
    tracing::info!(session_id = %session_id, "oturum kapatıldı");
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
        _ => Err(format!("bilinmeyen protokol: {}", s)),
    }
}
