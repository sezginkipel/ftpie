use anyhow::Result;
use serde::{Deserialize, Serialize};

pub mod client;
pub mod types;

pub use client::FtpSession;
pub use types::{ConnectionConfig, RemoteFile, TransferMode};

/// FTP bağlantı protokolü
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Ftp,
    Ftps,
    FtpsImplicit,
    Sftp,
    WebDav,
    S3,
}

/// Bağlantı durumu
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected { server: String, user: String },
    Error(String),
}
