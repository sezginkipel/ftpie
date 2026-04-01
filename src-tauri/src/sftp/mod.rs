//! SFTP protocol implementation via russh + russh-sftp
//! TODO: Phase 1 MVP implementation

use anyhow::Result;

pub struct SftpClient;

impl SftpClient {
    pub async fn connect(_host: &str, _port: u16, _user: &str, _pass: &str) -> Result<Self> {
        // TODO: russh bağlantısı
        Ok(Self)
    }
}
