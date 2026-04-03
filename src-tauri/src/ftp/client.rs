use anyhow::{Context, Result};
use std::io::Cursor;
use std::path::Path;

use super::types::{ConnectionConfig, RemoteFile, TransferMode};
use crate::ftp::Protocol;

// ── İç stream tipi ───────────────────────────────────────────────────────────

enum Inner {
    Plain(suppaftp::FtpStream),
    Tls(suppaftp::NativeTlsFtpStream),
}

macro_rules! dispatch {
    ($self:expr, $method:ident ( $($arg:expr),* )) => {
        match &mut $self.inner {
            Inner::Plain(s) => s.$method($($arg),*),
            Inner::Tls(s)   => s.$method($($arg),*),
        }
    };
}

// ── FTP Oturumu ───────────────────────────────────────────────────────────────

pub struct FtpSession {
    pub config: ConnectionConfig,
    inner: Inner,
}

impl FtpSession {
    pub fn connect(config: ConnectionConfig) -> Result<Self> {
        use std::net::ToSocketAddrs;
        use std::time::Duration;

        let addr_str = format!("{}:{}", config.host, config.port);
        let timeout = Duration::from_secs(config.timeout_secs);

        let socket_addr = addr_str
            .to_socket_addrs()
            .with_context(|| format!("DNS çözümlenemedi: {}", addr_str))?
            .next()
            .ok_or_else(|| anyhow::anyhow!("Adres bulunamadı: {}", addr_str))?;

        match config.protocol {
            Protocol::Ftps | Protocol::FtpsImplicit => {
                // Explicit TLS (AUTH TLS):
                // suppaftp'de NativeTlsFtpStream ile bağlanıp into_secure ile TLS'e yükseltilir.
                let tls_connector = native_tls::TlsConnector::builder()
                    .danger_accept_invalid_certs(true) // self-signed sertifika desteği
                    .danger_accept_invalid_hostnames(true)
                    .build()
                    .context("TLS connector oluşturulamadı")?;

                let suppaftp_connector = suppaftp::NativeTlsConnector::from(tls_connector);

                // NativeTlsFtpStream ile plain bağlan (aynı port 21), sonra TLS'e yükselt
                let plain = suppaftp::NativeTlsFtpStream::connect_timeout(socket_addr, timeout)
                    .with_context(|| format!("FTPS bağlantı başarısız: {}", addr_str))?;

                let mut stream = plain
                    .into_secure(suppaftp_connector, &config.host)
                    .with_context(|| format!("FTPS TLS el sıkışması başarısız: {}", addr_str))?;

                if config.passive_mode {
                    stream.set_mode(suppaftp::Mode::Passive);
                }

                let password = config.password.clone().unwrap_or_default();
                stream
                    .login(&config.username, &password)
                    .with_context(|| format!("FTPS giriş başarısız: kullanıcı '{}'", config.username))?;

                tracing::info!(host = %config.host, user = %config.username, "FTPS bağlandı");
                Ok(Self { config, inner: Inner::Tls(stream) })
            }

            _ => {
                // Düz FTP
                let mut stream = suppaftp::FtpStream::connect_timeout(socket_addr, timeout)
                    .with_context(|| format!("FTP bağlantı başarısız: {}", addr_str))?;

                if config.passive_mode {
                    stream.set_mode(suppaftp::Mode::Passive);
                }

                let password = config.password.clone().unwrap_or_default();
                stream
                    .login(&config.username, &password)
                    .with_context(|| format!("FTP giriş başarısız: kullanıcı '{}'", config.username))?;

                tracing::info!(host = %config.host, user = %config.username, "FTP bağlandı");
                Ok(Self { config, inner: Inner::Plain(stream) })
            }
        }
    }

    pub fn list(&mut self, path: &str) -> Result<Vec<RemoteFile>> {
        let entries = dispatch!(self, list(Some(path)))
            .with_context(|| format!("LIST başarısız: {}", path))?;
        Ok(entries
            .iter()
            .filter_map(|line| parse_list_entry(line, path))
            .collect())
    }

    pub fn read_file_bytes(&mut self, remote_path: &str) -> Result<Vec<u8>> {
        let cursor = dispatch!(self, retr_as_buffer(remote_path))
            .with_context(|| format!("RETR başarısız: {}", remote_path))?;
        Ok(cursor.into_inner())
    }

    pub fn write_file_bytes(&mut self, remote_path: &str, data: &[u8]) -> Result<u64> {
        let mut reader = Cursor::new(data);
        dispatch!(self, put_file(remote_path, &mut reader))
            .with_context(|| format!("STOR başarısız: {}", remote_path))
            .map(|n| n as u64)
    }

    pub fn upload_local(&mut self, local_path: &Path, remote_path: &str) -> Result<u64> {
        let data = std::fs::read(local_path)
            .with_context(|| format!("yerel dosya okunamadı: {}", local_path.display()))?;
        self.write_file_bytes(remote_path, &data)
    }

    pub fn download_to_local(&mut self, remote_path: &str, local_path: &Path) -> Result<u64> {
        let data = self.read_file_bytes(remote_path)?;
        if let Some(parent) = local_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(local_path, &data)?;
        Ok(data.len() as u64)
    }

    pub fn mkdir(&mut self, path: &str) -> Result<()> {
        dispatch!(self, mkdir(path))
            .with_context(|| format!("MKD başarısız: {}", path))
    }

    pub fn delete_file(&mut self, path: &str) -> Result<()> {
        dispatch!(self, rm(path))
            .with_context(|| format!("DELE başarısız: {}", path))
    }

    pub fn delete_dir(&mut self, path: &str) -> Result<()> {
        dispatch!(self, rmdir(path))
            .with_context(|| format!("RMD başarısız: {}", path))
    }

    pub fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        dispatch!(self, rename(from, to))
            .with_context(|| format!("RNFR/RNTO başarısız: {} → {}", from, to))
    }

    pub fn chmod(&mut self, path: &str, permissions: u32) -> Result<()> {
        let cmd = format!("SITE CHMOD {:o} {}", permissions, path);
        match &mut self.inner {
            Inner::Plain(s) => s.custom_command(&cmd, &[suppaftp::Status::CommandOk]),
            Inner::Tls(s)   => s.custom_command(&cmd, &[suppaftp::Status::CommandOk]),
        }
        .with_context(|| format!("CHMOD başarısız: {}", path))?;
        Ok(())
    }

    pub fn pwd(&mut self) -> Result<String> {
        dispatch!(self, pwd()).context("PWD başarısız")
    }

    pub fn cwd(&mut self, path: &str) -> Result<()> {
        dispatch!(self, cwd(path))
            .with_context(|| format!("CWD başarısız: {}", path))
    }
}

// ── LIST satır parser ────────────────────────────────────────────────────────

fn parse_list_entry(line: &str, parent_path: &str) -> Option<RemoteFile> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 9 {
        return None;
    }

    let perms = parts[0];
    let size: u64 = parts[4].parse().unwrap_or(0);
    let name = parts[8..].join(" ");

    if name == "." || name == ".." {
        return None;
    }

    let is_dir = perms.starts_with('d');
    let is_symlink = perms.starts_with('l');
    let path = if parent_path.ends_with('/') {
        format!("{}{}", parent_path, name)
    } else {
        format!("{}/{}", parent_path, name)
    };

    Some(RemoteFile {
        name,
        path,
        size,
        is_dir,
        is_symlink,
        permissions: Some(perms.to_string()),
        modified: None,
        owner: Some(parts[2].to_string()),
        group: Some(parts[3].to_string()),
    })
}
