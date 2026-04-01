use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub protocol: super::Protocol,
    pub passive_mode: bool,
    pub timeout_secs: u64,
}

impl Default for ConnectionConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: 21,
            username: String::new(),
            password: None,
            protocol: super::Protocol::Ftp,
            passive_mode: true,
            timeout_secs: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub permissions: Option<String>,
    pub modified: Option<DateTime<Utc>>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum TransferMode {
    Binary,
    Ascii,
}
