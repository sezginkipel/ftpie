use anyhow::{Context, Result};
use std::io::Cursor;
use std::path::Path;
use suppaftp::FtpStream;

use super::types::{ConnectionConfig, RemoteFile, TransferMode};

/// FTP bağlantısını ve stream'i tutan oturum
pub struct FtpSession {
    pub config: ConnectionConfig,
    pub stream: FtpStream,
}

impl FtpSession {
    /// FTP/FTPS bağlantısı kur ve döndür
    pub fn connect(config: ConnectionConfig) -> Result<Self> {
        let addr = format!("{}:{}", config.host, config.port);

        let mut stream = FtpStream::connect(&addr)
            .with_context(|| format!("cannot connect to {}", addr))?;

        let password = config.password.as_deref().unwrap_or("");
        stream
            .login(&config.username, password)
            .context("FTP login failed")?;

        if config.passive_mode {
            stream.set_mode(suppaftp::Mode::Passive);
        }

        tracing::info!(host = %config.host, user = %config.username, "FTP connected");
        Ok(Self { config, stream })
    }

    pub fn disconnect(&mut self) -> Result<()> {
        self.stream.quit().context("FTP quit failed")?;
        tracing::info!("FTP disconnected");
        Ok(())
    }

    pub fn list(&mut self, path: &str) -> Result<Vec<RemoteFile>> {
        let entries = self
            .stream
            .list(Some(path))
            .with_context(|| format!("LIST failed for {}", path))?;

        Ok(entries
            .iter()
            .filter_map(|line| parse_list_entry(line, path))
            .collect())
    }

    pub fn read_file_bytes(&mut self, remote_path: &str) -> Result<Vec<u8>> {
        let cursor = self
            .stream
            .retr_as_buffer(remote_path)
            .with_context(|| format!("RETR failed for {}", remote_path))?;
        Ok(cursor.into_inner())
    }

    pub fn write_file_bytes(&mut self, remote_path: &str, data: &[u8]) -> Result<u64> {
        let mut reader = Cursor::new(data);
        let bytes = self
            .stream
            .put_file(remote_path, &mut reader)
            .with_context(|| format!("STOR failed for {}", remote_path))?;
        Ok(bytes as u64)
    }

    pub fn upload_local(&mut self, local_path: &Path, remote_path: &str) -> Result<u64> {
        let data = std::fs::read(local_path)
            .with_context(|| format!("cannot read {}", local_path.display()))?;
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
        self.stream
            .mkdir(path)
            .with_context(|| format!("MKD failed for {}", path))
    }

    pub fn delete_file(&mut self, path: &str) -> Result<()> {
        self.stream
            .rm(path)
            .with_context(|| format!("DELE failed for {}", path))
    }

    pub fn delete_dir(&mut self, path: &str) -> Result<()> {
        self.stream
            .rmdir(path)
            .with_context(|| format!("RMD failed for {}", path))
    }

    pub fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        self.stream
            .rename(from, to)
            .with_context(|| format!("RNFR/RNTO failed: {} → {}", from, to))
    }

    pub fn chmod(&mut self, path: &str, permissions: u32) -> Result<()> {
        // SITE CHMOD komutu çoğu FTP sunucusunda desteklenir
        let cmd = format!("SITE CHMOD {:o} {}", permissions, path);
        self.stream
            .site_command(&cmd)
            .with_context(|| format!("CHMOD failed for {}", path))?;
        Ok(())
    }

    pub fn pwd(&mut self) -> Result<String> {
        self.stream.pwd().context("PWD failed")
    }

    pub fn cwd(&mut self, path: &str) -> Result<()> {
        self.stream
            .cwd(path)
            .with_context(|| format!("CWD failed for {}", path))
    }
}

/// Unix-style LIST satırını parse eder
fn parse_list_entry(line: &str, parent_path: &str) -> Option<RemoteFile> {
    // Basit parser: "drwxr-xr-x  2 user group 4096 Jan  1 12:00 dirname"
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
        modified: None, // TODO: parse date from parts[5..7]
        owner: Some(parts[2].to_string()),
        group: Some(parts[3].to_string()),
    })
}
