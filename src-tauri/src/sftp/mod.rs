//! SFTP transport built on `russh` + `russh-sftp`.
//!
//! Security-relevant behaviour of this module:
//!
//! * The SSH host key is verified against the trust-on-first-use
//!   [`TrustStore`]. `check_server_key` used to return `Ok(true)`
//!   unconditionally, which made every SFTP session trivially
//!   machine-in-the-middle-able. It now computes the OpenSSH
//!   `SHA256:<base64>` fingerprint of the presented key and only accepts a
//!   pinned match; anything else aborts the handshake and is reported to the
//!   UI as [`AppError::UntrustedHost`] so the user can decide.
//! * Public-key authentication is actually implemented. `private_key_path` and
//!   `key_passphrase` were previously parsed from the frontend and then ignored,
//!   so "key auth" silently fell back to an empty password.
//! * Transfers stream in 64 KiB chunks with cancellation checks, instead of
//!   buffering whole files in memory.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use russh::keys::PublicKeyBase64;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::fs::Metadata;
use russh_sftp::protocol::{FileAttributes, StatusCode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{AppError, AppResult, TrustKind};
use crate::ftp::types::{ConnectionConfig, RemoteFile};
use crate::transfer::TransferCtl;
use crate::trust::{fingerprint_sha256, TrustStore, TrustVerdict};

/// Transfer chunk size, as mandated by the project's transfer contract.
const CHUNK_SIZE: usize = 64 * 1024;

/// Upper bound for the whole-file helpers used by the text editor. Anything
/// larger has to go through the streaming download path.
const MAX_WHOLE_FILE_BYTES: u64 = 32 * 1024 * 1024;

/// A directory listing resolves symlinks with extra round trips; cap the work so
/// a directory full of links cannot stall the UI.
const MAX_SYMLINK_RESOLUTIONS: usize = 128;

/// Poison-tolerant lock. A panic while holding one of these mutexes must not
/// take the rest of the session down with it.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ── Host key verification ───────────────────────────────────────────────────

/// What the server offered when we refused its host key. Filled in by the
/// handler during the key exchange and read back by [`SftpSession::connect`],
/// which turns it into an `AppError::UntrustedHost` for the trust dialog.
#[derive(Debug, Clone)]
struct RejectedHostKey {
    algorithm: String,
    fingerprint: String,
    verdict: TrustVerdict,
}

/// Read the algorithm name out of an SSH public-key blob.
///
/// The blob starts with a length-prefixed algorithm string ("ssh-ed25519",
/// "ssh-rsa", "ecdsa-sha2-nistp256", ...). Preferring this over
/// `PublicKey::name()` keeps the stored algorithm stable: for RSA keys `name()`
/// reports the *negotiated signature* algorithm (`rsa-sha2-256` vs
/// `rsa-sha2-512`), which can differ between connections to the same server.
fn wire_algorithm(blob: &[u8]) -> Option<String> {
    let len_bytes = blob.get(..4)?;
    let len = u32::from_be_bytes([len_bytes[0], len_bytes[1], len_bytes[2], len_bytes[3]]) as usize;
    // Guard against a bogus length before slicing.
    if len == 0 || len > 64 || blob.len() < 4 + len {
        return None;
    }
    let name = std::str::from_utf8(&blob[4..4 + len]).ok()?;
    if name.is_empty() || !name.is_ascii() {
        return None;
    }
    Some(name.to_string())
}

struct SshClientHandler {
    host: String,
    port: u16,
    trust: Arc<Mutex<TrustStore>>,
    /// Written when the presented key is not trusted, so `connect` can report
    /// the exact fingerprint the user has to confirm.
    rejected: Arc<Mutex<Option<RejectedHostKey>>>,
}

#[async_trait]
impl russh::client::Handler for SshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Canonical SSH wire encoding of the key — the same bytes OpenSSH
        // fingerprints, so our "SHA256:..." matches `ssh-keyscan` output.
        let blob = server_public_key.public_key_bytes();
        let fingerprint = fingerprint_sha256(&blob);
        let algorithm =
            wire_algorithm(&blob).unwrap_or_else(|| server_public_key.name().to_string());

        let verdict = lock(&self.trust).is_trusted(
            &self.host,
            self.port,
            TrustKind::SshHostKey,
            &fingerprint,
        );

        match verdict {
            TrustVerdict::Trusted => {
                tracing::debug!(
                    host = %self.host,
                    port = self.port,
                    %algorithm,
                    %fingerprint,
                    "SSH host key matches a pinned entry"
                );
                Ok(true)
            }
            other => {
                tracing::warn!(
                    host = %self.host,
                    port = self.port,
                    %algorithm,
                    %fingerprint,
                    verdict = ?other,
                    "refusing SSH host key; awaiting user confirmation"
                );
                *lock(&self.rejected) = Some(RejectedHostKey {
                    algorithm,
                    fingerprint,
                    verdict: other,
                });
                // russh turns this into a failed key exchange, so no traffic and
                // no credentials ever reach an unverified peer.
                Ok(false)
            }
        }
    }
}

// ── Error mapping ───────────────────────────────────────────────────────────

/// Translate an SFTP status packet into a structured `AppError` so the frontend
/// can react to `not_found` / `permission` instead of string-matching a message.
fn map_status(op: &str, path: &str, status: russh_sftp::protocol::Status) -> AppError {
    let detail = status.error_message.trim().to_string();
    let suffix = if detail.is_empty() {
        String::new()
    } else {
        format!(": {detail}")
    };
    match status.status_code {
        StatusCode::NoSuchFile => AppError::NotFound {
            path: path.to_string(),
            message: format!("{op} failed: no such file or directory: {path}{suffix}"),
        },
        StatusCode::PermissionDenied => {
            AppError::permission(format!("{op} failed: permission denied: {path}{suffix}"))
        }
        StatusCode::OpUnsupported => AppError::protocol(format!(
            "{op} failed: the server does not support this operation: {path}{suffix}"
        )),
        StatusCode::NoConnection | StatusCode::ConnectionLost => {
            AppError::net(format!("{op} failed: SFTP connection lost: {path}{suffix}"))
        }
        StatusCode::BadMessage => AppError::protocol(format!(
            "{op} failed: malformed SFTP response for {path}{suffix}"
        )),
        StatusCode::Eof => AppError::protocol(format!(
            "{op} failed: unexpected end of file for {path}{suffix}"
        )),
        // SFTP v3 has no dedicated "already exists" / "not empty" codes, so
        // servers funnel those through the generic failure code.
        StatusCode::Failure | StatusCode::Ok => {
            AppError::protocol(format!("{op} failed for {path}{suffix}"))
        }
    }
}

fn map_sftp_error(op: &str, path: &str, err: SftpError) -> AppError {
    match err {
        SftpError::Status(status) => map_status(op, path, status),
        SftpError::Timeout => AppError::timeout(format!(
            "{op} timed out waiting for the SFTP server ({path})"
        )),
        SftpError::IO(msg) => AppError::io(format!("{op} failed for {path}: {msg}")),
        SftpError::Limited(msg) => {
            AppError::protocol(format!("{op} exceeded a server limit for {path}: {msg}"))
        }
        SftpError::UnexpectedPacket => {
            AppError::protocol(format!("{op} failed for {path}: unexpected SFTP packet"))
        }
        SftpError::UnexpectedBehavior(msg) => {
            AppError::protocol(format!("{op} failed for {path}: {msg}"))
        }
    }
}

/// True when the error looks like "the path is already there", which `mkdir_all`
/// has to tolerate while walking intermediate components.
fn is_already_exists(err: &SftpError) -> bool {
    match err {
        SftpError::Status(status) => matches!(
            status.status_code,
            StatusCode::Failure | StatusCode::PermissionDenied
        ),
        _ => false,
    }
}

// ── Path helpers ────────────────────────────────────────────────────────────

/// Decompose a remote path into the sequence of directories that must exist,
/// shallowest first: `/a/b/c` becomes `["/a", "/a/b", "/a/b/c"]`.
///
/// Empty components, `.` components and trailing slashes are ignored; relative
/// paths stay relative.
fn ancestor_dirs(path: &str) -> Vec<String> {
    let absolute = path.starts_with('/');
    let mut out = Vec::new();
    let mut current = String::new();
    for part in path.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if absolute || !current.is_empty() {
            current.push('/');
        }
        current.push_str(part);
        out.push(current.clone());
    }
    out
}

fn join_remote(parent: &str, name: &str) -> String {
    RemoteFile::join_path(parent, name)
}

/// `<target>.part` — downloads land here first so an interrupted transfer never
/// looks like a complete file.
fn partial_path(local: &Path) -> PathBuf {
    let mut name = local.as_os_str().to_os_string();
    name.push(".part");
    PathBuf::from(name)
}

// ── Metadata conversion ─────────────────────────────────────────────────────

/// Convert SFTP attributes into the shared `RemoteFile` shape.
///
/// `mode` keeps the raw permission bits so `chmod` can round-trip, while
/// `permissions` carries the human `rwxr-xr-x` rendering the UI shows.
fn metadata_to_remote_file(name: String, path: String, meta: &Metadata) -> RemoteFile {
    let file_type = meta.file_type();
    let mode = meta.permissions.map(|p| p & 0o7777);
    let permissions = meta.permissions.map(|_| meta.permissions().to_string());

    let modified = meta
        .mtime
        .and_then(|secs| chrono::DateTime::<chrono::Utc>::from_timestamp(i64::from(secs), 0));

    RemoteFile {
        name,
        path,
        size: meta.len(),
        is_dir: file_type.is_dir(),
        is_symlink: file_type.is_symlink(),
        symlink_target: None,
        permissions,
        mode,
        modified,
        owner: meta
            .user
            .clone()
            .or_else(|| meta.uid.map(|u| u.to_string())),
        group: meta
            .group
            .clone()
            .or_else(|| meta.gid.map(|g| g.to_string())),
    }
}

// ── Session ─────────────────────────────────────────────────────────────────

/// An authenticated SFTP session over a live SSH connection.
pub struct SftpSession {
    pub config: ConnectionConfig,
    sftp: russh_sftp::client::SftpSession,
    /// Owning handle for the SSH connection. Dropping it tears the transport
    /// down, so it must outlive `sftp`.
    conn: russh::client::Handle<SshClientHandler>,
}

impl SftpSession {
    /// Open an SSH connection, verify the host key, authenticate and start the
    /// SFTP subsystem.
    pub async fn connect(
        config: ConnectionConfig,
        trust: Arc<Mutex<TrustStore>>,
    ) -> AppResult<Self> {
        let io_timeout = config.io_timeout();

        // Keepalives make a dead peer observable. Without them (the previous
        // `Config::default()`) a half-open connection stayed "connected"
        // forever and every operation blocked on it.
        let keepalive_interval = std::cmp::max(std::time::Duration::from_secs(5), io_timeout / 2);
        let keepalive_max = 3usize;
        // A responsive server answers keepalives, which resets the inactivity
        // timer; the budget therefore only has to outlast the keepalive probes.
        let inactivity_timeout = keepalive_interval * (keepalive_max as u32 + 1);

        let ssh_config = Arc::new(russh::client::Config {
            inactivity_timeout: Some(inactivity_timeout),
            keepalive_interval: Some(keepalive_interval),
            keepalive_max,
            ..Default::default()
        });

        let rejected: Arc<Mutex<Option<RejectedHostKey>>> = Arc::new(Mutex::new(None));
        let handler = SshClientHandler {
            host: config.host.clone(),
            port: config.port,
            trust,
            rejected: Arc::clone(&rejected),
        };

        let connect_fut =
            russh::client::connect(ssh_config, (config.host.as_str(), config.port), handler);

        let mut handle = match tokio::time::timeout(config.connect_timeout(), connect_fut).await {
            Err(_) => {
                // A host-key rejection that races the connect budget must still
                // be reported as a trust problem. Reporting it as a timeout would
                // tell the user to retry, which is exactly the wrong advice when
                // the server's identity did not check out.
                if let Some(rejection) = lock(&rejected).take() {
                    return Err(TrustStore::untrusted_error(
                        &config.host,
                        config.port,
                        TrustKind::SshHostKey,
                        &rejection.algorithm,
                        &rejection.fingerprint,
                        &rejection.verdict,
                    ));
                }
                return Err(AppError::timeout(format!(
                    "SSH connection to {}:{} timed out after {}s",
                    config.host,
                    config.port,
                    config.connect_timeout().as_secs()
                )));
            }
            Ok(Ok(handle)) => handle,
            Ok(Err(e)) => {
                // A refused host key fails the key exchange, and russh surfaces
                // that as a plain disconnect — so consult our own record first
                // to produce the actionable trust error.
                if let Some(rejection) = lock(&rejected).take() {
                    return Err(TrustStore::untrusted_error(
                        &config.host,
                        config.port,
                        TrustKind::SshHostKey,
                        &rejection.algorithm,
                        &rejection.fingerprint,
                        &rejection.verdict,
                    ));
                }
                return Err(AppError::net(format!(
                    "SSH connection to {}:{} failed: {e}",
                    config.host, config.port
                )));
            }
        };

        Self::authenticate(&mut handle, &config).await?;

        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::net(format!("could not open an SSH session channel: {e}")))?;
        channel.request_subsystem(true, "sftp").await.map_err(|e| {
            AppError::protocol(format!("the server refused the SFTP subsystem: {e}"))
        })?;

        let sftp = russh_sftp::client::SftpSession::new_opts(
            channel.into_stream(),
            Some(config.io_timeout_secs.clamp(1, 3600)),
        )
        .await
        .map_err(|e| map_sftp_error("SFTP handshake", "/", e))?;

        tracing::info!(
            target = %config.target(),
            user = %config.username,
            "SFTP session established"
        );

        Ok(Self {
            config,
            sftp,
            conn: handle,
        })
    }

    /// Try public-key auth first when a key is configured, then password.
    async fn authenticate(
        handle: &mut russh::client::Handle<SshClientHandler>,
        config: &ConnectionConfig,
    ) -> AppResult<()> {
        let mut attempts: Vec<String> = Vec::new();

        let key_path = config
            .private_key_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty());

        if let Some(key_path) = key_path {
            match load_private_key(key_path, config.key_passphrase.clone()).await {
                Ok(key) => {
                    let ok = handle
                        .authenticate_publickey(config.username.as_str(), Arc::new(key))
                        .await
                        .map_err(|e| {
                            AppError::auth(format!(
                                "public-key authentication failed for {}: {e}",
                                config.username
                            ))
                        })?;
                    if ok {
                        tracing::info!(user = %config.username, "SFTP authenticated with a private key");
                        return Ok(());
                    }
                    attempts.push(format!(
                        "public key '{key_path}' was rejected by the server"
                    ));
                }
                Err(e) => {
                    // A key we cannot even load is worth reporting, but a
                    // configured password should still get its chance.
                    attempts.push(format!("{e}"));
                }
            }
        }

        let password = config.password.as_deref().filter(|p| !p.is_empty());
        if let Some(password) = password {
            let ok = handle
                .authenticate_password(config.username.as_str(), password)
                .await
                .map_err(|e| {
                    AppError::auth(format!(
                        "password authentication failed for {}: {e}",
                        config.username
                    ))
                })?;
            if ok {
                tracing::info!(user = %config.username, "SFTP authenticated with a password");
                return Ok(());
            }
            attempts.push("the password was rejected by the server".to_string());
        }

        if attempts.is_empty() {
            return Err(AppError::auth(format!(
                "no SFTP credentials supplied for {}: provide a password or a private key",
                config.username
            )));
        }

        Err(AppError::auth(format!(
            "SFTP authentication failed for {}: {}",
            config.username,
            attempts.join("; ")
        )))
    }

    pub fn config(&self) -> &ConnectionConfig {
        &self.config
    }

    /// List a remote directory. Symlinks keep their target and, where it can be
    /// resolved cheaply, report whether the target is a directory.
    pub async fn list(&self, path: &str) -> AppResult<Vec<RemoteFile>> {
        let entries = self
            .sftp
            .read_dir(path)
            .await
            .map_err(|e| map_sftp_error("list", path, e))?;

        let mut out = Vec::new();
        let mut resolutions = 0usize;

        for entry in entries {
            let name = entry.file_name();
            // The server chooses these strings, and they end up joined onto a
            // local download path and onto remote paths for recursive delete.
            // Anything that is not a single plain component is dropped rather
            // than trusted. See `ftp::types::is_safe_entry_name`.
            if !crate::ftp::types::is_safe_entry_name(&name) {
                tracing::warn!(
                    entry = %name,
                    "ignoring a directory entry whose name is not a single safe path component"
                );
                continue;
            }
            let full_path = join_remote(path, &name);
            let meta = entry.metadata();
            let mut file = metadata_to_remote_file(name, full_path.clone(), &meta);

            if file.is_symlink && resolutions < MAX_SYMLINK_RESOLUTIONS {
                resolutions += 1;
                // Best-effort: a dangling link must not fail the whole listing.
                if let Ok(target) = self.sftp.read_link(full_path.clone()).await {
                    file.symlink_target = Some(target);
                }
                if let Ok(target_meta) = self.sftp.metadata(full_path.clone()).await {
                    file.is_dir = target_meta.file_type().is_dir();
                }
            }

            out.push(file);
        }

        out.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    }

    /// Read a whole file into memory. Only for the editor — bounded by
    /// [`MAX_WHOLE_FILE_BYTES`] so a stray click on a disk image cannot exhaust
    /// the process.
    pub async fn read_file_bytes(&self, remote: &str) -> AppResult<Vec<u8>> {
        let size = self.size(remote).await.unwrap_or(0);
        if size > MAX_WHOLE_FILE_BYTES {
            return Err(AppError::protocol(format!(
                "{remote} is {size} bytes, which is above the {MAX_WHOLE_FILE_BYTES} byte \
                 in-memory limit; download it instead"
            )));
        }

        let mut file = self
            .sftp
            .open(remote)
            .await
            .map_err(|e| map_sftp_error("open", remote, e))?;

        let mut out: Vec<u8> = Vec::with_capacity(size.min(MAX_WHOLE_FILE_BYTES) as usize);
        let mut buf = vec![0u8; CHUNK_SIZE];
        loop {
            let n = file
                .read(&mut buf)
                .await
                .map_err(|e| AppError::io(format!("read failed for {remote}: {e}")))?;
            if n == 0 {
                break;
            }
            if out.len() as u64 + n as u64 > MAX_WHOLE_FILE_BYTES {
                return Err(AppError::protocol(format!(
                    "{remote} exceeds the {MAX_WHOLE_FILE_BYTES} byte in-memory limit while \
                     reading; download it instead"
                )));
            }
            out.extend_from_slice(&buf[..n]);
        }
        Ok(out)
    }

    /// Overwrite a remote file from memory. Editor counterpart of
    /// [`Self::read_file_bytes`], with the same size guard.
    pub async fn write_file_bytes(&self, remote: &str, data: &[u8]) -> AppResult<u64> {
        if data.len() as u64 > MAX_WHOLE_FILE_BYTES {
            return Err(AppError::protocol(format!(
                "refusing to buffer {} bytes for {remote}; the in-memory limit is \
                 {MAX_WHOLE_FILE_BYTES} bytes, use an upload instead",
                data.len()
            )));
        }

        let mut file = self
            .sftp
            .create(remote)
            .await
            .map_err(|e| map_sftp_error("create", remote, e))?;

        for chunk in data.chunks(CHUNK_SIZE) {
            file.write_all(chunk)
                .await
                .map_err(|e| AppError::io(format!("write failed for {remote}: {e}")))?;
        }
        file.flush()
            .await
            .map_err(|e| AppError::io(format!("flush failed for {remote}: {e}")))?;
        file.shutdown()
            .await
            .map_err(|e| AppError::io(format!("close failed for {remote}: {e}")))?;
        Ok(data.len() as u64)
    }

    /// Stream a remote file to disk in 64 KiB chunks.
    ///
    /// Data lands in `<local>.part` and is renamed only after the last byte, so
    /// a cancelled or failed transfer never leaves a truncated file that looks
    /// complete. The partial file is removed on both cancellation and error.
    pub async fn download_to_local(
        &self,
        remote: &str,
        local: &Path,
        ctl: &TransferCtl,
    ) -> AppResult<u64> {
        ctl.check()?;

        if let Some(parent) = local.parent() {
            if !parent.as_os_str().is_empty() {
                tokio::fs::create_dir_all(parent).await.map_err(|e| {
                    AppError::io(format!(
                        "could not create local directory {}: {e}",
                        parent.display()
                    ))
                })?;
            }
        }

        let part = partial_path(local);
        let result = self.download_into_part(remote, &part, ctl).await;

        match result {
            Ok(total) => {
                tokio::fs::rename(&part, local).await.map_err(|e| {
                    AppError::io(format!(
                        "could not move {} into place at {}: {e}",
                        part.display(),
                        local.display()
                    ))
                })?;
                Ok(total)
            }
            Err(e) => {
                // Best effort cleanup; the original error is what matters.
                let _ = tokio::fs::remove_file(&part).await;
                Err(e)
            }
        }
    }

    async fn download_into_part(
        &self,
        remote: &str,
        part: &Path,
        ctl: &TransferCtl,
    ) -> AppResult<u64> {
        let mut source = self
            .sftp
            .open(remote)
            .await
            .map_err(|e| map_sftp_error("open", remote, e))?;

        let mut sink = tokio::fs::File::create(part)
            .await
            .map_err(|e| AppError::io(format!("could not create {}: {e}", part.display())))?;

        let mut buf = vec![0u8; CHUNK_SIZE];
        let mut total = 0u64;
        loop {
            ctl.check()?;
            let n = source
                .read(&mut buf)
                .await
                .map_err(|e| AppError::io(format!("read failed for {remote}: {e}")))?;
            if n == 0 {
                break;
            }
            sink.write_all(&buf[..n])
                .await
                .map_err(|e| AppError::io(format!("write failed for {}: {e}", part.display())))?;
            total += n as u64;
            ctl.tick(n as u64);
            ctl.check()?;
        }

        sink.flush()
            .await
            .map_err(|e| AppError::io(format!("flush failed for {}: {e}", part.display())))?;
        sink.sync_all()
            .await
            .map_err(|e| AppError::io(format!("fsync failed for {}: {e}", part.display())))?;
        Ok(total)
    }

    /// Stream a local file to the server in 64 KiB chunks.
    ///
    /// On cancellation or error the partially written remote file is removed, so
    /// a half-uploaded artefact is never left behind.
    pub async fn upload_local(
        &self,
        local: &Path,
        remote: &str,
        ctl: &TransferCtl,
    ) -> AppResult<u64> {
        ctl.check()?;

        let mut source = tokio::fs::File::open(local)
            .await
            .map_err(|e| AppError::io(format!("could not open {}: {e}", local.display())))?;

        let result = async {
            let mut sink = self
                .sftp
                .create(remote)
                .await
                .map_err(|e| map_sftp_error("create", remote, e))?;

            let mut buf = vec![0u8; CHUNK_SIZE];
            let mut total = 0u64;
            loop {
                ctl.check()?;
                let n = source.read(&mut buf).await.map_err(|e| {
                    AppError::io(format!("read failed for {}: {e}", local.display()))
                })?;
                if n == 0 {
                    break;
                }
                sink.write_all(&buf[..n])
                    .await
                    .map_err(|e| AppError::io(format!("write failed for {remote}: {e}")))?;
                total += n as u64;
                ctl.tick(n as u64);
                ctl.check()?;
            }

            sink.flush()
                .await
                .map_err(|e| AppError::io(format!("flush failed for {remote}: {e}")))?;
            let _ = sink.sync_all().await;
            sink.shutdown()
                .await
                .map_err(|e| AppError::io(format!("close failed for {remote}: {e}")))?;
            Ok::<u64, AppError>(total)
        }
        .await;

        match result {
            Ok(total) => Ok(total),
            Err(e) => {
                let _ = self.sftp.remove_file(remote).await;
                Err(e)
            }
        }
    }

    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        self.sftp
            .create_dir(path)
            .await
            .map_err(|e| map_sftp_error("mkdir", path, e))
    }

    /// Create `path` and every missing parent, tolerating components that
    /// already exist.
    pub async fn mkdir_all(&self, path: &str) -> AppResult<()> {
        for dir in ancestor_dirs(path) {
            match self.sftp.create_dir(dir.clone()).await {
                Ok(()) => {}
                Err(e) if is_already_exists(&e) => {
                    // SFTP v3 reports "exists" as a generic failure, so confirm
                    // by stat instead of trusting the message text.
                    match self.sftp.metadata(dir.clone()).await {
                        Ok(meta) if meta.file_type().is_dir() => continue,
                        Ok(_) => {
                            return Err(AppError::protocol(format!(
                                "mkdir failed for {dir}: the path exists but is not a directory"
                            )))
                        }
                        Err(_) => return Err(map_sftp_error("mkdir", &dir, e)),
                    }
                }
                Err(e) => return Err(map_sftp_error("mkdir", &dir, e)),
            }
        }
        Ok(())
    }

    pub async fn delete_file(&self, path: &str) -> AppResult<()> {
        self.sftp
            .remove_file(path)
            .await
            .map_err(|e| map_sftp_error("delete", path, e))
    }

    pub async fn delete_dir(&self, path: &str) -> AppResult<()> {
        self.sftp
            .remove_dir(path)
            .await
            .map_err(|e| map_sftp_error("rmdir", path, e))
    }

    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        self.sftp
            .rename(from, to)
            .await
            .map_err(|e| map_sftp_error(&format!("rename to {to}"), from, e))
    }

    pub async fn chmod(&self, path: &str, mode: u32) -> AppResult<()> {
        // `FileAttributes::empty()` matters here: `default()` carries
        // `size: Some(0)`, and a SETSTAT with a size would truncate the file.
        let mut attrs = FileAttributes::empty();
        attrs.permissions = Some(mode & 0o7777);
        self.sftp
            .set_metadata(path, attrs)
            .await
            .map_err(|e| map_sftp_error("chmod", path, e))
    }

    pub async fn size(&self, path: &str) -> AppResult<u64> {
        let meta = self
            .sftp
            .metadata(path)
            .await
            .map_err(|e| map_sftp_error("stat", path, e))?;
        Ok(meta.len())
    }

    /// Cheap round trip that proves the transport is still alive.
    pub async fn keepalive(&self) -> AppResult<()> {
        self.sftp
            .canonicalize(".")
            .await
            .map(|_| ())
            .map_err(|e| map_sftp_error("keepalive", ".", e))
    }

    /// Close the SFTP subsystem and the SSH transport.
    pub async fn disconnect(self) -> AppResult<()> {
        let host = self.config.host.clone();
        if let Err(e) = self.sftp.close().await {
            tracing::debug!(error = %e, "SFTP channel close reported an error");
        }
        if let Err(e) = self
            .conn
            .disconnect(russh::Disconnect::ByApplication, "client shutdown", "en")
            .await
        {
            tracing::debug!(error = %e, "SSH disconnect reported an error");
        }
        tracing::info!(%host, "SFTP session closed");
        Ok(())
    }
}

/// Load a private key off the async executor. `load_secret_key` does blocking
/// file IO and, for encrypted keys, a deliberately slow KDF.
async fn load_private_key(
    path: &str,
    passphrase: Option<String>,
) -> AppResult<russh::keys::key::KeyPair> {
    let owned = path.to_string();
    tokio::task::spawn_blocking(move || {
        russh::keys::load_secret_key(&owned, passphrase.as_deref()).map_err(|e| {
            AppError::auth(format!(
                "could not load the private key '{owned}': {e} \
                 (check the path and, for an encrypted key, the passphrase)"
            ))
        })
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh_sftp::protocol::Status;

    fn status(code: StatusCode, msg: &str) -> Status {
        Status {
            id: 1,
            status_code: code,
            error_message: msg.to_string(),
            language_tag: "en".to_string(),
        }
    }

    fn meta(permissions: Option<u32>, size: Option<u64>, mtime: Option<u32>) -> Metadata {
        Metadata {
            size,
            uid: Some(1000),
            user: Some("deploy".to_string()),
            gid: Some(1000),
            group: Some("www".to_string()),
            permissions,
            atime: None,
            mtime,
        }
    }

    // ── fingerprints ────────────────────────────────────────────────────────

    #[test]
    fn fingerprint_is_openssh_formatted() {
        let fp = fingerprint_sha256(b"some-ssh-key-blob");
        assert!(fp.starts_with("SHA256:"), "got {fp}");
        assert!(!fp.contains('='), "base64 must be unpadded: {fp}");
        assert_eq!(fp, fingerprint_sha256(b"some-ssh-key-blob"));
        assert_ne!(fp, fingerprint_sha256(b"some-ssh-key-blo"));
    }

    #[test]
    fn wire_algorithm_reads_the_leading_ssh_string() {
        let mut blob = Vec::new();
        let name = b"ssh-ed25519";
        blob.extend_from_slice(&(name.len() as u32).to_be_bytes());
        blob.extend_from_slice(name);
        blob.extend_from_slice(&[0u8; 32]);
        assert_eq!(wire_algorithm(&blob).as_deref(), Some("ssh-ed25519"));
    }

    #[test]
    fn wire_algorithm_rejects_garbage() {
        assert_eq!(wire_algorithm(&[]), None);
        assert_eq!(wire_algorithm(&[0, 0, 0, 4]), None, "truncated body");
        // Absurd length prefix must not panic or allocate.
        assert_eq!(wire_algorithm(&[0xff, 0xff, 0xff, 0xff, 1, 2, 3]), None);
        // Zero-length algorithm name is not a valid key blob.
        assert_eq!(wire_algorithm(&[0, 0, 0, 0]), None);
    }

    // ── error mapping ───────────────────────────────────────────────────────

    #[test]
    fn no_such_file_maps_to_not_found_with_the_path() {
        let err = map_status(
            "open",
            "/srv/missing.txt",
            status(StatusCode::NoSuchFile, ""),
        );
        match err {
            AppError::NotFound { path, .. } => assert_eq!(path, "/srv/missing.txt"),
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn permission_denied_maps_to_permission() {
        let err = map_status("open", "/root/x", status(StatusCode::PermissionDenied, ""));
        assert_eq!(err.code(), "permission");
    }

    #[test]
    fn transport_status_codes_map_to_network() {
        assert_eq!(
            map_status("read", "/x", status(StatusCode::ConnectionLost, "")).code(),
            "network"
        );
        assert_eq!(
            map_status("read", "/x", status(StatusCode::NoConnection, "")).code(),
            "network"
        );
    }

    #[test]
    fn generic_failure_maps_to_protocol_and_keeps_the_server_message() {
        let err = map_status(
            "mkdir",
            "/srv/app",
            status(StatusCode::Failure, "File exists"),
        );
        assert_eq!(err.code(), "protocol");
        assert!(err.to_string().contains("File exists"), "{err}");
        assert!(err.to_string().contains("/srv/app"), "{err}");
    }

    #[test]
    fn unsupported_operation_maps_to_protocol() {
        assert_eq!(
            map_status("chmod", "/x", status(StatusCode::OpUnsupported, "")).code(),
            "protocol"
        );
    }

    #[test]
    fn client_side_errors_map_to_their_own_codes() {
        assert_eq!(
            map_sftp_error("read", "/x", SftpError::Timeout).code(),
            "timeout"
        );
        assert_eq!(
            map_sftp_error("read", "/x", SftpError::IO("disk".into())).code(),
            "io"
        );
        assert_eq!(
            map_sftp_error("read", "/x", SftpError::UnexpectedPacket).code(),
            "protocol"
        );
    }

    #[test]
    fn only_ambiguous_failures_are_treated_as_maybe_existing() {
        assert!(is_already_exists(&SftpError::Status(status(
            StatusCode::Failure,
            "File exists"
        ))));
        assert!(!is_already_exists(&SftpError::Status(status(
            StatusCode::NoSuchFile,
            ""
        ))));
        assert!(!is_already_exists(&SftpError::Timeout));
    }

    // ── mkdir_all path decomposition ────────────────────────────────────────

    #[test]
    fn ancestor_dirs_walks_absolute_paths_shallowest_first() {
        assert_eq!(
            ancestor_dirs("/var/www/html"),
            vec!["/var", "/var/www", "/var/www/html"]
        );
    }

    #[test]
    fn ancestor_dirs_keeps_relative_paths_relative() {
        assert_eq!(ancestor_dirs("a/b"), vec!["a", "a/b"]);
        assert_eq!(ancestor_dirs("./a/b"), vec!["a", "a/b"]);
    }

    #[test]
    fn ancestor_dirs_ignores_empty_components_and_trailing_slashes() {
        assert_eq!(ancestor_dirs("/var//www/"), vec!["/var", "/var/www"]);
        assert_eq!(ancestor_dirs("/"), Vec::<String>::new());
        assert_eq!(ancestor_dirs(""), Vec::<String>::new());
        assert_eq!(ancestor_dirs("/a"), vec!["/a"]);
    }

    #[test]
    fn partial_path_appends_part_without_eating_the_extension() {
        let p = partial_path(Path::new("/tmp/archive.tar.gz"));
        assert_eq!(p, Path::new("/tmp/archive.tar.gz.part"));
    }

    // ── metadata conversion ─────────────────────────────────────────────────

    #[test]
    fn directory_metadata_sets_is_dir_and_renders_permissions() {
        // 0o40755 => directory, rwxr-xr-x
        let f = metadata_to_remote_file(
            "www".to_string(),
            "/var/www".to_string(),
            &meta(Some(0o040755), Some(4096), None),
        );
        assert!(f.is_dir);
        assert!(!f.is_symlink);
        assert_eq!(f.permissions.as_deref(), Some("rwxr-xr-x"));
        assert_eq!(f.mode, Some(0o755));
        assert_eq!(f.owner.as_deref(), Some("deploy"));
        assert_eq!(f.group.as_deref(), Some("www"));
    }

    #[test]
    fn regular_file_metadata_keeps_size_and_mode() {
        let f = metadata_to_remote_file(
            "app.log".to_string(),
            "/var/log/app.log".to_string(),
            &meta(Some(0o100640), Some(1234), None),
        );
        assert!(!f.is_dir);
        assert!(!f.is_symlink);
        assert_eq!(f.size, 1234);
        assert_eq!(f.mode, Some(0o640));
        assert_eq!(f.permissions.as_deref(), Some("rw-r-----"));
    }

    #[test]
    fn symlink_metadata_is_flagged_as_a_symlink_not_a_dir() {
        // 0o120777 => symlink
        let f = metadata_to_remote_file(
            "current".to_string(),
            "/srv/current".to_string(),
            &meta(Some(0o120777), Some(11), None),
        );
        assert!(f.is_symlink);
        assert!(!f.is_dir);
        // The target is filled in by `list` via READLINK, not by the conversion.
        assert_eq!(f.symlink_target, None);
    }

    #[test]
    fn missing_permissions_leave_mode_and_permissions_unset() {
        let f = metadata_to_remote_file(
            "x".to_string(),
            "/x".to_string(),
            &meta(None, Some(0), None),
        );
        assert_eq!(f.mode, None);
        assert_eq!(f.permissions, None);
        assert!(!f.is_dir);
    }

    #[test]
    fn mtime_becomes_a_real_timestamp() {
        // 2021-01-01T00:00:00Z
        let f = metadata_to_remote_file(
            "x".to_string(),
            "/x".to_string(),
            &meta(Some(0o100644), Some(1), Some(1_609_459_200)),
        );
        let modified = f.modified.expect("mtime must be parsed, not dropped");
        assert_eq!(modified.timestamp(), 1_609_459_200);

        let without = metadata_to_remote_file(
            "y".to_string(),
            "/y".to_string(),
            &meta(Some(0o100644), Some(1), None),
        );
        assert_eq!(without.modified, None);
    }

    #[test]
    fn missing_size_reports_zero_rather_than_panicking() {
        let f = metadata_to_remote_file("x".to_string(), "/x".to_string(), &meta(None, None, None));
        assert_eq!(f.size, 0);
    }
}
