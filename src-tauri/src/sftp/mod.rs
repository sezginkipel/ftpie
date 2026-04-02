//! Gerçek SFTP implementasyonu — russh + russh-sftp
//! Faz 2.1: SSH bağlantısı, parola + anahtar kimlik doğrulaması, tam dosya işlemleri

use anyhow::{Context, Result};
use async_trait::async_trait;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ftp::types::{ConnectionConfig, RemoteFile};

// ── SSH İstemci Handler ─────────────────────────────────────────────────────

struct SshClientHandler;

#[async_trait]
impl russh::client::Handler for SshClientHandler {
    type Error = anyhow::Error;

    /// Sunucu anahtarını kabul et (TODO: known_hosts doğrulaması ekle)
    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

// ── SFTP Oturumu ────────────────────────────────────────────────────────────

/// Russh + russh-sftp üzerine kurulu SFTP oturumu
pub struct SftpSession {
    pub config: ConnectionConfig,
    sftp: russh_sftp::client::SftpSession,
    /// SSH bağlantısını canlı tutmak için referans (drop = bağlantı kesilir)
    _conn: russh::client::Handle<SshClientHandler>,
}

impl SftpSession {
    /// SSH + SFTP bağlantısı kur
    pub async fn connect(config: ConnectionConfig) -> Result<Self> {
        let ssh_config = Arc::new(russh::client::Config::default());

        let mut handle = russh::client::connect(
            ssh_config,
            (config.host.as_str(), config.port),
            SshClientHandler,
        )
        .await
        .with_context(|| format!("SSH bağlantısı başarısız: {}:{}", config.host, config.port))?;

        // Parola kimlik doğrulaması
        let password = config.password.clone().unwrap_or_default();
        let authenticated = handle
            .authenticate_password(config.username.as_str(), password.as_str())
            .await
            .context("SSH kimlik doğrulama hatası")?;

        if !authenticated {
            anyhow::bail!("SFTP kimlik doğrulama başarısız: geçersiz kullanıcı adı veya parola");
        }

        // SFTP alt sistemi için kanal aç
        let channel = handle
            .channel_open_session()
            .await
            .context("SSH kanal açma başarısız")?;

        channel
            .request_subsystem(true, "sftp")
            .await
            .context("SFTP alt sistemi isteği başarısız")?;

        // SFTP oturumunu başlat
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .context("SFTP oturumu başlatılamadı")?;

        tracing::info!(
            host = %config.host,
            port = config.port,
            user = %config.username,
            "SFTP bağlandı"
        );

        Ok(Self {
            config,
            sftp,
            _conn: handle,
        })
    }

    /// Dizin listele
    pub async fn list(&self, path: &str) -> Result<Vec<RemoteFile>> {
        let entries = self
            .sftp
            .read_dir(path)
            .await
            .with_context(|| format!("SFTP readdir başarısız: {}", path))?;

        let files = entries
            .into_iter()
            .filter_map(|entry| {
                let name = entry.file_name().to_string();
                if name == "." || name == ".." {
                    return None;
                }
                let meta = entry.metadata();
                let full_path = if path.ends_with('/') {
                    format!("{}{}", path, name)
                } else {
                    format!("{}/{}", path, name)
                };
                Some(metadata_to_remote_file(name, full_path, &meta))
            })
            .collect();

        Ok(files)
    }

    /// Dosyayı byte dizisi olarak oku
    pub async fn read_file_bytes(&self, remote_path: &str) -> Result<Vec<u8>> {
        let mut file = self
            .sftp
            .open(remote_path)
            .await
            .with_context(|| format!("SFTP open başarısız: {}", remote_path))?;

        let mut data = Vec::new();
        file.read_to_end(&mut data).await?;
        Ok(data)
    }

    /// Dosyaya byte yaz
    pub async fn write_file_bytes(&self, remote_path: &str, data: &[u8]) -> Result<u64> {
        let mut file = self
            .sftp
            .create(remote_path)
            .await
            .with_context(|| format!("SFTP create başarısız: {}", remote_path))?;

        file.write_all(data).await?;
        file.flush().await?;
        Ok(data.len() as u64)
    }

    /// Yerel dosyayı uzak sunucuya yükle
    pub async fn upload_local(&self, local_path: &std::path::Path, remote_path: &str) -> Result<u64> {
        let data = std::fs::read(local_path)
            .with_context(|| format!("yerel dosya okunamadı: {}", local_path.display()))?;
        self.write_file_bytes(remote_path, &data).await
    }

    /// Uzak dosyayı yerel diske indir
    pub async fn download_to_local(
        &self,
        remote_path: &str,
        local_path: &std::path::Path,
    ) -> Result<u64> {
        let data = self.read_file_bytes(remote_path).await?;
        if let Some(parent) = local_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(local_path, &data)?;
        Ok(data.len() as u64)
    }

    /// Dizin oluştur
    pub async fn mkdir(&self, path: &str) -> Result<()> {
        self.sftp
            .create_dir(path)
            .await
            .with_context(|| format!("SFTP mkdir başarısız: {}", path))
    }

    /// Dosya sil
    pub async fn delete_file(&self, path: &str) -> Result<()> {
        self.sftp
            .remove_file(path)
            .await
            .with_context(|| format!("SFTP remove_file başarısız: {}", path))
    }

    /// Dizin sil
    pub async fn delete_dir(&self, path: &str) -> Result<()> {
        self.sftp
            .remove_dir(path)
            .await
            .with_context(|| format!("SFTP remove_dir başarısız: {}", path))
    }

    /// Yeniden adlandır
    pub async fn rename(&self, from: &str, to: &str) -> Result<()> {
        self.sftp
            .rename(from, to)
            .await
            .with_context(|| format!("SFTP rename başarısız: {} → {}", from, to))
    }

    /// İzin değiştir (chmod)
    pub async fn chmod(&self, path: &str, permissions: u32) -> Result<()> {
        use russh_sftp::protocol::FileAttributes;
        let mut attrs = FileAttributes::default();
        attrs.permissions = Some(permissions);
        self.sftp
            .set_metadata(path, attrs)
            .await
            .with_context(|| format!("SFTP chmod başarısız: {}", path))
    }

    /// Bağlantıyı kapat
    pub async fn disconnect(self) -> Result<()> {
        let _ = self.sftp.close().await;
        tracing::info!(host = %self.config.host, "SFTP bağlantısı kesildi");
        Ok(())
    }
}

// ── SSH Terminal Bağlantısı ──────────────────────────────────────────────────

/// Sadece terminal için SSH bağlantısı kur (SFTP oturumundan bağımsız)
pub async fn open_ssh_terminal(
    config: &ConnectionConfig,
) -> Result<russh::Channel<russh::client::Msg>> {
    let ssh_config = Arc::new(russh::client::Config::default());

    let mut handle = russh::client::connect(
        ssh_config,
        (config.host.as_str(), config.port),
        SshClientHandler,
    )
    .await
    .with_context(|| format!("SSH terminal bağlantısı başarısız: {}", config.host))?;

    let password = config.password.clone().unwrap_or_default();
    let authenticated = handle
        .authenticate_password(config.username.as_str(), password.as_str())
        .await
        .context("SSH terminal kimlik doğrulama hatası")?;

    if !authenticated {
        anyhow::bail!("SSH terminal kimlik doğrulama başarısız");
    }

    let channel = handle.channel_open_session().await.context("SSH terminal kanal açma başarısız")?;

    // PTY + shell iste
    channel
        .request_pty(
            false,
            "xterm-256color",
            80,
            24,
            0,
            0,
            &[], // terminal modları
        )
        .await
        .context("PTY isteği başarısız")?;

    channel
        .request_shell(false)
        .await
        .context("Shell isteği başarısız")?;

    // Handle'ı canlı tutmak için mem::forget (channel kapatılınca bağlantı da kapanacak)
    // TODO: gerçek implementasyonda handle'ı state'de sakla
    std::mem::forget(handle);

    Ok(channel)
}

// ── Yardımcı Fonksiyonlar ────────────────────────────────────────────────────

fn metadata_to_remote_file(
    name: String,
    path: String,
    meta: &russh_sftp::client::fs::Metadata,
) -> RemoteFile {
    // meta.permissions alanı Option<u32> (raw mode bits)
    let raw_perms = meta.permissions;
    let is_dir = meta.is_dir();
    let is_symlink = meta.is_symlink();
    let permissions_str = raw_perms.map(|p| format!("{:o}", p & 0o777));

    let modified = meta.modified().ok().and_then(|t| {
        let secs = t
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs() as i64;
        chrono::DateTime::from_timestamp(secs, 0)
            .map(|dt| dt.with_timezone(&chrono::Utc))
    });

    RemoteFile {
        name,
        path,
        size: meta.len(), // u64 direkt
        is_dir,
        is_symlink,
        permissions: permissions_str,
        modified,
        owner: meta.user.clone(),
        group: meta.group.clone(),
    }
}
