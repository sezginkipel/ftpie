//! Synchronous FTP / FTPS session.
//!
//! Three transports live here:
//!
//! * `Protocol::Ftp` — plaintext.
//! * `Protocol::Ftps` — explicit FTPS: connect in the clear, then `AUTH TLS`.
//! * `Protocol::FtpsImplicit` — implicit FTPS: TLS from the first byte, normally
//!   on port 990. This is a genuinely separate code path, not an `AUTH TLS`
//!   upgrade (see [`spawn_tls_bridge`] for why it needs a loopback shim).
//!
//! Certificates are verified for real. The previous implementation passed
//! `danger_accept_invalid_certs(true)` unconditionally, which turned FTPS into
//! "encrypted, but to whoever answers the port". Now an unknown or changed
//! certificate aborts the connection and is reported to the user as
//! [`AppError::UntrustedHost`]; only a fingerprint the user explicitly pinned in
//! the [`TrustStore`] is accepted, and then only that exact certificate.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Datelike, NaiveDate, TimeZone, Utc};
use suppaftp::types::FileType;
use suppaftp::{FtpError, Status};

use super::types::{ConnectionConfig, RemoteFile};
use crate::error::{AppError, AppResult, TrustKind};
use crate::ftp::Protocol;
use crate::transfer::TransferCtl;
use crate::trust::{fingerprint_sha256, TrustEntry, TrustStore, TrustVerdict};

/// Transfer chunk size. Every chunk ticks progress and checks cancellation.
const CHUNK: usize = 64 * 1024;

/// Ceiling for the whole-file helpers used by the text editor. Anything larger
/// must go through the streaming transfer path instead of into memory.
const MAX_INLINE_BYTES: u64 = 32 * 1024 * 1024;

/// `native_tls` exposes no way to read a certificate's subject, so trust entries
/// for TLS record the identity type rather than a signature algorithm. The
/// fingerprint is what actually pins the peer.
const TLS_ALGORITHM: &str = "x509";

/// Recover a poisoned trust-store lock instead of propagating the panic.
/// `crate::state::lock_or_recover` does the same thing, but this module must not
/// depend on `state` (which owns sessions, which own this type).
fn lock_trust(trust: &Mutex<TrustStore>) -> std::sync::MutexGuard<'_, TrustStore> {
    trust.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------
// Inner transport
// ---------------------------------------------------------------------------

enum Inner {
    /// Plaintext FTP.
    Plain(suppaftp::FtpStream),
    /// Explicit FTPS: suppaftp owns the TLS session (control and data).
    Explicit(suppaftp::NativeTlsFtpStream),
    /// Implicit FTPS: we own the TLS session and suppaftp talks to the plaintext
    /// end of a loopback bridge, so its stream type is the non-TLS one.
    Implicit(suppaftp::FtpStream),
}

/// Call a method that has the same return type on every transport.
macro_rules! dispatch {
    ($self:expr, $method:ident ( $($arg:expr),* )) => {
        match &mut $self.inner {
            Inner::Plain(s) | Inner::Implicit(s) => s.$method($($arg),*),
            Inner::Explicit(s) => s.$method($($arg),*),
        }
    };
}

/// Stream `RETR` output into `out`.
///
/// This is a macro rather than a function because `retr_as_stream` returns
/// `DataStream<T>` with a different `T` per transport, and suppaftp's `TlsStream`
/// trait is private, so the two instantiations cannot be unified behind a
/// generic bound or a trait object (`dyn Read + Write` would not satisfy both
/// `finalize_retr_stream(impl Write)` and `abort(impl Read)`).
///
/// `$out` must be a `&mut` expression. Yields `AppResult<u64>`.
macro_rules! retr_into {
    ($s:expr, $remote:expr, $out:expr, $ctl:expr, $limit:expr) => {{
        let remote: &str = $remote;
        let ctl: &TransferCtl = $ctl;
        let limit: u64 = $limit;
        let out: &mut dyn std::io::Write = $out;
        match $s.retr_as_stream(remote) {
            Err(e) => Err(map_ftp_error(e, remote)),
            Ok(mut stream) => {
                let mut buf = vec![0u8; CHUNK];
                let mut total: u64 = 0;
                let mut failure: Option<AppError> = None;
                loop {
                    if let Err(e) = ctl.check() {
                        failure = Some(e);
                        break;
                    }
                    match std::io::Read::read(&mut stream, &mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if total.saturating_add(n as u64) > limit {
                                failure = Some(AppError::protocol(format!(
                                    "{remote} exceeds the {limit} byte limit for this operation; \
                                     use a file transfer instead"
                                )));
                                break;
                            }
                            if let Err(e) = out.write_all(&buf[..n]) {
                                failure = Some(AppError::from(e));
                                break;
                            }
                            total += n as u64;
                            ctl.tick(n as u64);
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(e) => {
                            failure = Some(AppError::from(e));
                            break;
                        }
                    }
                }
                match failure {
                    None => $s
                        .finalize_retr_stream(stream)
                        .map(|_| total)
                        .map_err(|e| map_ftp_error(e, remote)),
                    Some(err) => {
                        // ABOR leaves the control channel usable for the next
                        // command instead of desynchronised.
                        let _ = $s.abort(stream);
                        Err(err)
                    }
                }
            }
        }
    }};
}

/// Stream `$src` into a `STOR`. Same rationale as [`retr_into`].
macro_rules! store_from {
    ($s:expr, $remote:expr, $src:expr, $ctl:expr) => {{
        let remote: &str = $remote;
        let ctl: &TransferCtl = $ctl;
        let src: &mut dyn std::io::Read = $src;
        match $s.put_with_stream(remote) {
            Err(e) => Err(map_ftp_error(e, remote)),
            Ok(mut stream) => {
                let mut buf = vec![0u8; CHUNK];
                let mut total: u64 = 0;
                let mut failure: Option<AppError> = None;
                loop {
                    if let Err(e) = ctl.check() {
                        failure = Some(e);
                        break;
                    }
                    let n = match src.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => n,
                        Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(e) => {
                            failure = Some(AppError::from(e));
                            break;
                        }
                    };
                    if let Err(e) = std::io::Write::write_all(&mut stream, &buf[..n]) {
                        failure = Some(AppError::from(e));
                        break;
                    }
                    total += n as u64;
                    ctl.tick(n as u64);
                }
                match failure {
                    None => match std::io::Write::flush(&mut stream) {
                        Err(e) => {
                            let _ = $s.abort(stream);
                            Err(AppError::from(e))
                        }
                        Ok(()) => $s
                            .finalize_put_stream(stream)
                            .map(|_| total)
                            .map_err(|e| map_ftp_error(e, remote)),
                    },
                    Some(err) => {
                        let _ = $s.abort(stream);
                        Err(err)
                    }
                }
            }
        }
    }};
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

pub struct FtpSession {
    config: ConnectionConfig,
    inner: Inner,
    /// Cleared the first time the server rejects `MLSD`, so we stop paying for a
    /// failed command on every directory change.
    mlsd_supported: bool,
}

impl FtpSession {
    pub fn connect(config: ConnectionConfig, trust: &Mutex<TrustStore>) -> AppResult<Self> {
        let addr = resolve_addr(&config)?;
        let io = config.io_timeout();
        let connect_to = config.connect_timeout();

        let inner = match config.protocol {
            Protocol::Sftp => {
                return Err(AppError::config(
                    "FtpSession cannot serve the sftp protocol; use SftpSession".to_string(),
                ));
            }

            Protocol::Ftp => {
                let stream = suppaftp::FtpStream::connect_timeout(addr, connect_to)
                    .map_err(|e| map_ftp_error(e, &config.target()))?;
                apply_socket_timeouts(stream.get_ref(), io)?;
                Inner::Plain(stream.passive_stream_builder(plain_data_builder(connect_to, io)))
            }

            Protocol::Ftps => {
                // Pinning decision happens before we send credentials anywhere.
                let connector = resolve_tls_connector(addr, &config, trust)?;
                let stream = suppaftp::NativeTlsFtpStream::connect_timeout(addr, connect_to)
                    .map_err(|e| map_ftp_error(e, &config.target()))?;
                apply_socket_timeouts(stream.get_ref(), io)?;
                let stream = stream.passive_stream_builder(plain_data_builder(connect_to, io));
                let stream = stream
                    .into_secure(suppaftp::NativeTlsConnector::from(connector), &config.host)
                    .map_err(|e| map_ftp_error(e, &config.target()))?;
                apply_socket_timeouts(stream.get_ref(), io)?;
                Inner::Explicit(stream)
            }

            Protocol::FtpsImplicit => {
                let connector = resolve_tls_connector(addr, &config, trust)?;
                let tcp = TcpStream::connect_timeout(&addr, connect_to).map_err(AppError::from)?;
                let _ = tcp.set_nodelay(true);
                apply_socket_timeouts(&tcp, connect_to)?;
                let tls = connector
                    .connect(&config.host, tcp)
                    .map_err(handshake_error)?;
                // Hand suppaftp the plaintext end of our own TLS session.
                let local = spawn_tls_bridge(tls, "control")?;
                apply_socket_timeouts(&local, io)?;
                let _ = local.set_nodelay(true);
                let stream = suppaftp::FtpStream::connect_with_stream(local)
                    .map_err(|e| map_ftp_error(e, &config.target()))?;
                Inner::Implicit(stream.passive_stream_builder(implicit_data_builder(
                    connector,
                    config.host.clone(),
                    connect_to,
                    io,
                )))
            }
        };

        let mut session = Self {
            config,
            inner,
            mlsd_supported: true,
        };

        session.set_mode();

        if session.config.protocol == Protocol::FtpsImplicit {
            // RFC 4217 protection negotiation. Implicit servers usually default
            // to a protected data channel, but ours *is* TLS-wrapped by the
            // bridge, so ask explicitly. Best effort: some implicit-only servers
            // reject PBSZ/PROT because the answer is implied.
            for cmd in ["PBSZ 0", "PROT P"] {
                if let Err(e) = dispatch!(
                    session,
                    custom_command(cmd, &[Status::CommandOk, Status::CommandNotImplemented])
                ) {
                    tracing::warn!(command = cmd, error = %e, "implicit FTPS server rejected protection negotiation");
                }
            }
        }

        let password = session.config.password.clone().unwrap_or_default();
        let username = session.config.username.clone();
        dispatch!(session, login(username.as_str(), password.as_str())).map_err(|e| {
            let mapped = map_ftp_error(e, &session.config.target());
            match mapped {
                AppError::Protocol { message } | AppError::NotFound { message, .. } => {
                    AppError::auth(format!("Login failed for user '{username}': {message}"))
                }
                other => other,
            }
        })?;

        // Servers default to ASCII, which silently corrupts binaries and makes
        // SIZE meaningless. Ask for image/binary mode once, up front.
        if let Err(e) = dispatch!(session, transfer_type(FileType::Binary)) {
            tracing::warn!(error = %e, "server refused TYPE I; transfers may be mangled");
        }

        tracing::info!(
            target = %session.config.target(),
            user = %session.config.username,
            "FTP session established"
        );
        Ok(session)
    }

    fn set_mode(&mut self) {
        let mode = if self.config.passive_mode {
            suppaftp::Mode::Passive
        } else {
            suppaftp::Mode::Active
        };
        match &mut self.inner {
            Inner::Plain(s) | Inner::Implicit(s) => s.set_mode(mode),
            Inner::Explicit(s) => s.set_mode(mode),
        }
    }

    pub fn config(&self) -> &ConnectionConfig {
        &self.config
    }

    // -- listing ------------------------------------------------------------

    pub fn list(&mut self, path: &str) -> AppResult<Vec<RemoteFile>> {
        let dir = normalize_dir(path);
        let now = Utc::now();

        if self.mlsd_supported {
            match dispatch!(self, mlsd(Some(dir.as_str()))) {
                Ok(lines) => {
                    let outcome = parse_listing(&lines, &dir, true, now);
                    if outcome.recognized > 0 || lines.is_empty() {
                        return Ok(outcome.files);
                    }
                    tracing::warn!(
                        dir = %dir,
                        "MLSD returned unparseable output; falling back to LIST"
                    );
                    self.mlsd_supported = false;
                }
                Err(e) => {
                    // A refusal (500/502/504/550) means "no MLSD here"; a
                    // transport failure is a real error and must surface.
                    if is_command_refusal(&e) {
                        tracing::debug!(dir = %dir, "server does not support MLSD; using LIST");
                        self.mlsd_supported = false;
                    } else {
                        return Err(map_ftp_error(e, &dir));
                    }
                }
            }
        }

        let lines =
            dispatch!(self, list(Some(dir.as_str()))).map_err(|e| map_ftp_error(e, &dir))?;
        let outcome = parse_listing(&lines, &dir, false, now);
        if outcome.recognized == 0 && !lines.is_empty() {
            let sample = outcome
                .unrecognized
                .first()
                .cloned()
                .unwrap_or_else(|| lines[0].clone());
            return Err(AppError::protocol(format!(
                "Unrecognized directory listing format for '{dir}'. The server returned \
                 {} line(s) and none matched MLSD, Unix `ls -l` or DOS/IIS layout. First \
                 unparsed line: {sample:?}",
                lines.len()
            )));
        }
        Ok(outcome.files)
    }

    // -- whole-file helpers (editor only) -----------------------------------

    /// Read a small remote file into memory. Intended for the text editor; large
    /// files must use [`FtpSession::download_to_local`].
    pub fn read_file_bytes(&mut self, remote: &str) -> AppResult<Vec<u8>> {
        if let Ok(size) = self.size(remote) {
            if size > MAX_INLINE_BYTES {
                return Err(AppError::protocol(format!(
                    "{remote} is {size} bytes; only files up to {MAX_INLINE_BYTES} bytes can be \
                     opened in the editor"
                )));
            }
        }
        let ctl = TransferCtl::noop();
        let mut buf: Vec<u8> = Vec::new();
        let result = match &mut self.inner {
            Inner::Plain(s) | Inner::Implicit(s) => {
                retr_into!(s, remote, &mut buf, &ctl, MAX_INLINE_BYTES)
            }
            Inner::Explicit(s) => retr_into!(s, remote, &mut buf, &ctl, MAX_INLINE_BYTES),
        };
        result.map(|_| buf)
    }

    pub fn write_file_bytes(&mut self, remote: &str, data: &[u8]) -> AppResult<u64> {
        if data.len() as u64 > MAX_INLINE_BYTES {
            return Err(AppError::protocol(format!(
                "refusing to buffer {} bytes for {remote}; use a file transfer instead",
                data.len()
            )));
        }
        let ctl = TransferCtl::noop();
        let mut src = std::io::Cursor::new(data);
        match &mut self.inner {
            Inner::Plain(s) | Inner::Implicit(s) => store_from!(s, remote, &mut src, &ctl),
            Inner::Explicit(s) => store_from!(s, remote, &mut src, &ctl),
        }
    }

    // -- streaming transfers ------------------------------------------------

    pub fn download_to_local(
        &mut self,
        remote: &str,
        local: &Path,
        ctl: &TransferCtl,
    ) -> AppResult<u64> {
        ctl.check()?;
        if let Some(parent) = local.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let part = partial_path(local);
        let mut file = std::fs::File::create(&part)?;

        let result = match &mut self.inner {
            Inner::Plain(s) | Inner::Implicit(s) => {
                retr_into!(s, remote, &mut file, ctl, u64::MAX)
            }
            Inner::Explicit(s) => retr_into!(s, remote, &mut file, ctl, u64::MAX),
        };

        match result {
            Ok(total) => {
                let flushed = file.flush().and_then(|()| file.sync_all());
                drop(file);
                if let Err(e) = flushed {
                    let _ = std::fs::remove_file(&part);
                    return Err(e.into());
                }
                // Replace atomically-ish: Windows rename fails onto an existing
                // file, so clear the destination first.
                if local.exists() {
                    let _ = std::fs::remove_file(local);
                }
                if let Err(e) = std::fs::rename(&part, local) {
                    let _ = std::fs::remove_file(&part);
                    return Err(e.into());
                }
                Ok(total)
            }
            Err(e) => {
                drop(file);
                let _ = std::fs::remove_file(&part);
                Err(e)
            }
        }
    }

    pub fn upload_local(
        &mut self,
        local: &Path,
        remote: &str,
        ctl: &TransferCtl,
    ) -> AppResult<u64> {
        ctl.check()?;
        let mut file = std::fs::File::open(local).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AppError::not_found(local.display().to_string()),
            _ => AppError::from(e),
        })?;
        let result = match &mut self.inner {
            Inner::Plain(s) | Inner::Implicit(s) => store_from!(s, remote, &mut file, ctl),
            Inner::Explicit(s) => store_from!(s, remote, &mut file, ctl),
        };
        if result.is_err() {
            // A cancelled or failed STOR leaves a truncated remote file behind.
            if let Err(e) = dispatch!(self, rm(remote)) {
                tracing::debug!(remote, error = %e, "could not remove partial upload");
            }
        }
        result
    }

    // -- directory / file operations ---------------------------------------

    pub fn mkdir(&mut self, path: &str) -> AppResult<()> {
        dispatch!(self, mkdir(path)).map_err(|e| map_ftp_error(e, path))
    }

    /// Create `path` and every missing parent, tolerating components that
    /// already exist.
    pub fn mkdir_all(&mut self, path: &str) -> AppResult<()> {
        let mut prefix = if path.starts_with('/') {
            String::from("/")
        } else {
            String::new()
        };
        let components: Vec<&str> = path.split('/').filter(|c| !c.is_empty()).collect();
        if components.is_empty() {
            return Ok(());
        }
        let last = components.len() - 1;
        for (i, component) in components.into_iter().enumerate() {
            if !prefix.is_empty() && !prefix.ends_with('/') {
                prefix.push('/');
            }
            prefix.push_str(component);
            match dispatch!(self, mkdir(prefix.as_str())) {
                Ok(()) => {}
                Err(e) if is_already_exists(&e) => {
                    tracing::trace!(path = %prefix, "directory already exists");
                }
                Err(e) => {
                    let mapped = map_ftp_error(e, &prefix);
                    if i == last {
                        return Err(mapped);
                    }
                    // An intermediate failure is only fatal if the final mkdir
                    // fails too, so keep going but remember why.
                    tracing::debug!(path = %prefix, error = %mapped, "mkdir of intermediate path failed");
                }
            }
        }
        Ok(())
    }

    pub fn delete_file(&mut self, path: &str) -> AppResult<()> {
        dispatch!(self, rm(path)).map_err(|e| map_ftp_error(e, path))
    }

    pub fn delete_dir(&mut self, path: &str) -> AppResult<()> {
        dispatch!(self, rmdir(path)).map_err(|e| map_ftp_error(e, path))
    }

    pub fn rename(&mut self, from: &str, to: &str) -> AppResult<()> {
        dispatch!(self, rename(from, to)).map_err(|e| map_ftp_error(e, from))
    }

    pub fn chmod(&mut self, path: &str, mode: u32) -> AppResult<()> {
        let cmd = format!("SITE CHMOD {:03o} {}", mode & 0o7777, path);
        dispatch!(
            self,
            custom_command(
                cmd.as_str(),
                &[Status::CommandOk, Status::RequestedFileActionOk]
            )
        )
        .map(|_| ())
        .map_err(|e| map_ftp_error(e, path))
    }

    /// `SIZE`, used to pre-fill transfer totals.
    pub fn size(&mut self, path: &str) -> AppResult<u64> {
        dispatch!(self, size(path))
            .map(|n| n as u64)
            .map_err(|e| map_ftp_error(e, path))
    }

    /// Keepalive. Cheap enough to run on an idle-session timer.
    pub fn noop(&mut self) -> AppResult<()> {
        dispatch!(self, noop()).map_err(|e| map_ftp_error(e, "NOOP"))
    }

    /// Graceful `QUIT`. Consumes the session either way.
    pub fn quit(mut self) -> AppResult<()> {
        dispatch!(self, quit()).map_err(|e| map_ftp_error(e, "QUIT"))
    }

    pub fn pwd(&mut self) -> AppResult<String> {
        dispatch!(self, pwd()).map_err(|e| map_ftp_error(e, "PWD"))
    }
}

// ---------------------------------------------------------------------------
// Addressing and socket setup
// ---------------------------------------------------------------------------

fn resolve_addr(config: &ConnectionConfig) -> AppResult<SocketAddr> {
    if config.host.trim().is_empty() {
        return Err(AppError::config("Host is empty".to_string()));
    }
    let target = format!("{}:{}", config.host, config.port);
    target
        .to_socket_addrs()
        .map_err(|e| AppError::net(format!("Cannot resolve {target}: {e}")))?
        .next()
        .ok_or_else(|| AppError::net(format!("No address found for {target}")))
}

fn apply_socket_timeouts(socket: &TcpStream, io: Duration) -> AppResult<()> {
    socket
        .set_read_timeout(Some(io))
        .map_err(|e| AppError::io(format!("cannot set socket read timeout: {e}")))?;
    socket
        .set_write_timeout(Some(io))
        .map_err(|e| AppError::io(format!("cannot set socket write timeout: {e}")))?;
    Ok(())
}

/// Passive-mode data connections for plaintext FTP and explicit FTPS. suppaftp
/// wraps the returned socket in TLS itself when the session is secure, so the
/// timeouts we set here apply to the data channel too.
fn plain_data_builder(
    connect_to: Duration,
    io: Duration,
) -> impl Fn(SocketAddr) -> suppaftp::FtpResult<TcpStream> + Send + Sync + 'static {
    move |addr| {
        let socket =
            TcpStream::connect_timeout(&addr, connect_to).map_err(FtpError::ConnectionError)?;
        socket
            .set_read_timeout(Some(io))
            .map_err(FtpError::ConnectionError)?;
        socket
            .set_write_timeout(Some(io))
            .map_err(FtpError::ConnectionError)?;
        Ok(socket)
    }
}

/// Passive-mode data connections for implicit FTPS: TLS is ours, so every data
/// connection gets its own bridge.
fn implicit_data_builder(
    connector: native_tls::TlsConnector,
    domain: String,
    connect_to: Duration,
    io: Duration,
) -> impl Fn(SocketAddr) -> suppaftp::FtpResult<TcpStream> + Send + Sync + 'static {
    move |addr| {
        let socket =
            TcpStream::connect_timeout(&addr, connect_to).map_err(FtpError::ConnectionError)?;
        let _ = socket.set_nodelay(true);
        socket
            .set_read_timeout(Some(connect_to))
            .map_err(FtpError::ConnectionError)?;
        socket
            .set_write_timeout(Some(connect_to))
            .map_err(FtpError::ConnectionError)?;
        let tls = connector
            .connect(&domain, socket)
            .map_err(|e| FtpError::SecureError(e.to_string()))?;
        let local =
            spawn_tls_bridge(tls, "data").map_err(|e| FtpError::SecureError(e.to_string()))?;
        local
            .set_read_timeout(Some(io))
            .map_err(FtpError::ConnectionError)?;
        local
            .set_write_timeout(Some(io))
            .map_err(FtpError::ConnectionError)?;
        Ok(local)
    }
}

// ---------------------------------------------------------------------------
// TLS verification and certificate pinning
// ---------------------------------------------------------------------------

/// A probe failure that is specifically about the peer's certificate, versus one
/// that means the connection itself is broken.
enum ProbeError {
    /// Handshake rejected — most likely an untrusted or mismatched certificate.
    Certificate(String),
    Fatal(AppError),
}

fn strict_connector() -> AppResult<native_tls::TlsConnector> {
    native_tls::TlsConnector::builder()
        .build()
        .map_err(|e| AppError::internal(format!("cannot build TLS connector: {e}")))
}

/// Decide which connector to use for this host.
///
/// 1. Probe with a fully verifying connector. If the handshake succeeds the
///    server has a valid PKI certificate and we use that connector unchanged —
///    nothing needs pinning.
/// 2. Otherwise probe again with verification disabled *only to read the peer
///    certificate*, never to carry traffic: the probe socket is closed
///    immediately and no credentials are ever sent over it.
/// 3. Look the certificate's SHA-256 fingerprint up in the trust store.
///    `Trusted` yields a connector that trusts exactly that DER certificate and
///    nothing else; `Unknown` / `Changed` aborts with `AppError::UntrustedHost`
///    so the UI can show the fingerprint and let the user decide.
fn resolve_tls_connector(
    addr: SocketAddr,
    config: &ConnectionConfig,
    trust: &Mutex<TrustStore>,
) -> AppResult<native_tls::TlsConnector> {
    let strict = strict_connector()?;
    match tls_probe(addr, config, &strict) {
        Ok(_) => {
            tracing::debug!(target = %config.target(), "server certificate validated against system roots");
            return Ok(strict);
        }
        Err(ProbeError::Fatal(e)) => return Err(e),
        Err(ProbeError::Certificate(reason)) => {
            tracing::info!(
                target = %config.target(),
                reason = %reason,
                "certificate not accepted by the system trust store; checking pinned hosts"
            );
        }
    }

    let insecure = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
        .map_err(|e| AppError::internal(format!("cannot build inspection connector: {e}")))?;

    let der = match tls_probe(addr, config, &insecure) {
        Ok(der) => der,
        Err(ProbeError::Fatal(e)) => return Err(e),
        Err(ProbeError::Certificate(reason)) => {
            return Err(AppError::protocol(format!(
                "cannot read the server certificate for {}: {reason}",
                config.target()
            )));
        }
    };

    let fingerprint = fingerprint_sha256(&der);
    let verdict = {
        let store = lock_trust(trust);
        store.is_trusted(
            &config.host,
            config.port,
            TrustKind::TlsCertificate,
            &fingerprint,
        )
    };

    match verdict {
        TrustVerdict::Trusted => {
            // Pin this exact certificate.
            //
            // `disable_built_in_roots(true)` is essential and not optional:
            // `add_root_certificate` is *additive*, so without it the system
            // trust store still applies and — combined with the relaxed hostname
            // check below — this connector would accept any certificate chaining
            // to any public CA, for any name. Since the pinning decision is made
            // on a separate probe connection from the one that carries
            // credentials, an on-path attacker could let the probe reach the real
            // server, then present their own CA-issued certificate on the session
            // connection and collect the login. Disabling the built-in roots
            // makes the pinned certificate the only acceptable anchor.
            //
            // Hostname verification stays relaxed because pinned self-signed
            // certificates routinely carry a CN that does not match the address
            // the user typed. That is safe here only because the trust anchor set
            // is exactly one certificate the user explicitly approved for this
            // host and port.
            let cert = native_tls::Certificate::from_der(&der)
                .map_err(|e| AppError::protocol(format!("malformed server certificate: {e}")))?;
            let pinned = native_tls::TlsConnector::builder()
                .disable_built_in_roots(true)
                .add_root_certificate(cert)
                .danger_accept_invalid_hostnames(true)
                .build()
                .map_err(|e| AppError::internal(format!("cannot build pinned connector: {e}")))?;
            tracing::info!(
                target = %config.target(),
                fingerprint = %fingerprint,
                "using pinned server certificate"
            );
            Ok(pinned)
        }
        other => Err(TrustStore::untrusted_error(
            &config.host,
            config.port,
            TrustKind::TlsCertificate,
            TLS_ALGORITHM,
            &fingerprint,
            &other,
        )),
    }
}

/// Complete one TLS handshake and return the peer certificate's DER bytes.
///
/// For explicit FTPS this performs the `AUTH TLS` dance by hand: suppaftp's
/// secure stream never exposes the underlying `native_tls::TlsStream`, so there
/// is no way to read the peer certificate through it.
// `ProbeError` wraps `AppError`, which is a wide enum by design so the frontend
// gets structured error data. Boxing it here would just move the cost onto the
// happy path of every caller.
#[allow(clippy::result_large_err)]
fn tls_probe(
    addr: SocketAddr,
    config: &ConnectionConfig,
    connector: &native_tls::TlsConnector,
) -> Result<Vec<u8>, ProbeError> {
    let timeout = config.connect_timeout();
    let mut tcp = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|e| ProbeError::Fatal(AppError::from(e)))?;
    let _ = tcp.set_nodelay(true);
    apply_socket_timeouts(&tcp, timeout).map_err(ProbeError::Fatal)?;

    if config.protocol == Protocol::Ftps {
        let (code, body) = read_reply(&mut tcp).map_err(ProbeError::Fatal)?;
        if code / 100 != 2 {
            return Err(ProbeError::Fatal(AppError::protocol(format!(
                "unexpected FTP greeting from {}: {code} {body}",
                config.target()
            ))));
        }
        tcp.write_all(b"AUTH TLS\r\n")
            .map_err(|e| ProbeError::Fatal(AppError::from(e)))?;
        let (code, body) = read_reply(&mut tcp).map_err(ProbeError::Fatal)?;
        if code / 100 != 2 && code / 100 != 3 {
            return Err(ProbeError::Fatal(AppError::protocol(format!(
                "{} refused AUTH TLS ({code} {body}); the server may not support explicit FTPS",
                config.target()
            ))));
        }
    }

    match connector.connect(&config.host, tcp) {
        Ok(mut stream) => {
            let cert = stream
                .peer_certificate()
                .map_err(|e| {
                    ProbeError::Fatal(AppError::protocol(format!(
                        "cannot read peer certificate: {e}"
                    )))
                })?
                .ok_or_else(|| {
                    ProbeError::Fatal(AppError::protocol(
                        "server completed the TLS handshake without presenting a certificate"
                            .to_string(),
                    ))
                })?;
            let der = cert.to_der().map_err(|e| {
                ProbeError::Fatal(AppError::protocol(format!(
                    "cannot encode peer certificate: {e}"
                )))
            })?;
            let _ = stream.shutdown();
            Ok(der)
        }
        Err(native_tls::HandshakeError::Failure(e)) => Err(ProbeError::Certificate(e.to_string())),
        Err(native_tls::HandshakeError::WouldBlock(_)) => Err(ProbeError::Fatal(
            AppError::timeout(format!("TLS handshake with {} timed out", config.target())),
        )),
    }
}

fn handshake_error(e: native_tls::HandshakeError<TcpStream>) -> AppError {
    match e {
        native_tls::HandshakeError::Failure(e) => {
            AppError::protocol(format!("TLS handshake failed: {e}"))
        }
        native_tls::HandshakeError::WouldBlock(_) => {
            AppError::timeout("TLS handshake timed out".to_string())
        }
    }
}

/// Read one (possibly multi-line) FTP reply straight off the socket.
///
/// Deliberately unbuffered: the next thing on this socket is a TLS
/// ClientHello, and a `BufReader` could swallow part of it.
fn read_reply(socket: &mut TcpStream) -> AppResult<(u32, String)> {
    let mut body = String::new();
    let mut code: Option<u32> = None;
    loop {
        let line = read_line(socket)?;
        if line.len() < 4 {
            return Err(AppError::protocol(format!("malformed FTP reply: {line:?}")));
        }
        let this_code: u32 = line[..3]
            .parse()
            .map_err(|_| AppError::protocol(format!("malformed FTP reply code: {line:?}")))?;
        let separator = line.as_bytes()[3];
        body.push_str(line.trim_end());
        body.push(' ');
        if code.is_none() {
            code = Some(this_code);
        }
        if separator == b' ' && code == Some(this_code) {
            return Ok((this_code, body.trim().to_string()));
        }
        if body.len() > 8192 {
            return Err(AppError::protocol(
                "FTP reply exceeded 8 KiB without terminating".to_string(),
            ));
        }
    }
}

fn read_line(socket: &mut TcpStream) -> AppResult<String> {
    let mut out = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match socket.read(&mut byte) {
            Ok(0) => {
                return Err(AppError::net(
                    "server closed the connection while reading a reply".to_string(),
                ))
            }
            Ok(_) => {
                if byte[0] == b'\n' {
                    break;
                }
                out.push(byte[0]);
                if out.len() > 4096 {
                    return Err(AppError::protocol("FTP reply line too long".to_string()));
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(AppError::from(e)),
        }
    }
    Ok(String::from_utf8_lossy(&out).trim_end().to_string())
}

/// Convenience for the trust command layer: build the entry the UI should pin
/// after the user accepts a fingerprint.
pub fn tls_trust_entry(host: &str, port: u16, fingerprint: &str) -> TrustEntry {
    TrustEntry {
        host: host.to_string(),
        port,
        kind: TrustKind::TlsCertificate,
        algorithm: TLS_ALGORITHM.to_string(),
        fingerprint: fingerprint.to_string(),
        added_at: Utc::now(),
    }
}

// ---------------------------------------------------------------------------
// Implicit FTPS loopback bridge
// ---------------------------------------------------------------------------

/// Terminate a TLS session locally and expose its plaintext side as a loopback
/// `TcpStream`.
///
/// Why this exists: suppaftp 6.3 gates `connect_secure_implicit` behind its
/// `deprecated` cargo feature, which this crate does not enable, and the only
/// public constructor that accepts an existing connection —
/// `ImplFtpStream::connect_with_stream` — takes a bare `TcpStream`. The
/// `TlsConnector` / `TlsStream` traits that would let us inject an established
/// TLS stream are private to the crate. So to get *real* implicit FTPS (TLS from
/// the first byte, never an `AUTH TLS` upgrade) we own the TLS session and give
/// suppaftp the decrypted end.
///
/// The bridge is a single thread pumping both directions over non-blocking
/// sockets, so one `TlsStream` (which cannot be split or cloned) is enough.
/// Bytes on the wire are TLS from the very first byte; only the 127.0.0.1 hop
/// inside this process is plaintext.
///
/// Known limitation: `native_tls` offers no TLS session resumption, so servers
/// configured to require session reuse on the data channel (e.g. vsftpd's
/// `require_ssl_reuse=YES`) will reject data connections. suppaftp's own
/// explicit-FTPS path has the same limitation.
fn spawn_tls_bridge(
    tls: native_tls::TlsStream<TcpStream>,
    role: &'static str,
) -> AppResult<TcpStream> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| AppError::io(format!("cannot open the local TLS bridge: {e}")))?;
    let bridge_addr = listener
        .local_addr()
        .map_err(|e| AppError::io(format!("cannot inspect the local TLS bridge: {e}")))?;

    let app_side = TcpStream::connect(bridge_addr)
        .map_err(|e| AppError::io(format!("cannot connect to the local TLS bridge: {e}")))?;
    let expected = app_side
        .local_addr()
        .map_err(|e| AppError::io(format!("cannot inspect the bridge socket: {e}")))?;

    let (bridge_side, peer) = listener
        .accept()
        .map_err(|e| AppError::io(format!("local TLS bridge handshake failed: {e}")))?;
    // Another local process could theoretically win the race to our ephemeral
    // port; refuse anything that is not the socket we just opened ourselves.
    if peer != expected {
        return Err(AppError::internal(format!(
            "local TLS bridge was hijacked by {peer}"
        )));
    }
    drop(listener);
    let _ = bridge_side.set_nodelay(true);

    std::thread::Builder::new()
        .name(format!("ftpie-ftps-bridge-{role}"))
        .spawn(move || pump(bridge_side, tls))
        .map_err(|e| AppError::io(format!("cannot start the TLS bridge thread: {e}")))?;

    Ok(app_side)
}

/// One direction of the bridge.
struct Half {
    buf: Vec<u8>,
    start: usize,
    filled: usize,
    src_eof: bool,
    closed: bool,
}

impl Half {
    fn new() -> Self {
        Self {
            buf: vec![0u8; CHUNK],
            start: 0,
            filled: 0,
            src_eof: false,
            closed: false,
        }
    }
}

enum Step {
    Progress,
    Idle,
    /// Source is at EOF and everything read has been forwarded.
    Drained,
    Fatal,
}

/// Non-blocking read/write for one direction. Pending bytes are always retried
/// from the same buffer, which is what `native_tls` requires after `WouldBlock`.
fn pump_step<R: Read, W: Write>(src: &mut R, dst: &mut W, half: &mut Half) -> Step {
    let mut progress = false;
    while half.start < half.filled {
        match dst.write(&half.buf[half.start..half.filled]) {
            Ok(0) => return Step::Fatal,
            Ok(n) => {
                half.start += n;
                progress = true;
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                return if progress { Step::Progress } else { Step::Idle };
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Step::Fatal,
        }
    }
    half.start = 0;
    half.filled = 0;
    if half.src_eof {
        return Step::Drained;
    }
    match src.read(&mut half.buf) {
        Ok(0) => {
            half.src_eof = true;
            Step::Drained
        }
        Ok(n) => {
            half.filled = n;
            Step::Progress
        }
        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
            if progress {
                Step::Progress
            } else {
                Step::Idle
            }
        }
        Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => Step::Progress,
        Err(ref e) if is_eof_like(e) => {
            // FTPS servers frequently drop data connections without a
            // close_notify; treat that as end of stream so the plaintext side
            // still sees a clean FIN instead of a reset.
            half.src_eof = true;
            Step::Drained
        }
        Err(_) => Step::Fatal,
    }
}

fn is_eof_like(e: &std::io::Error) -> bool {
    use std::io::ErrorKind::*;
    matches!(
        e.kind(),
        UnexpectedEof | ConnectionAborted | ConnectionReset | BrokenPipe | NotConnected
    )
}

fn pump(mut plain: TcpStream, mut tls: native_tls::TlsStream<TcpStream>) {
    if plain.set_nonblocking(true).is_err() {
        return;
    }
    if tls.get_ref().set_nonblocking(true).is_err() {
        return;
    }

    let mut up = Half::new(); // plaintext -> TLS
    let mut down = Half::new(); // TLS -> plaintext

    loop {
        let mut progress = false;
        let mut fatal = false;

        match pump_step(&mut plain, &mut tls, &mut up) {
            Step::Progress => progress = true,
            Step::Idle => {}
            Step::Drained => {
                if !up.closed {
                    up.closed = true;
                    progress = true;
                    let _ = tls.shutdown();
                    let _ = tls.get_ref().shutdown(Shutdown::Write);
                }
            }
            Step::Fatal => fatal = true,
        }

        if !fatal {
            match pump_step(&mut tls, &mut plain, &mut down) {
                Step::Progress => progress = true,
                Step::Idle => {}
                Step::Drained => {
                    if !down.closed {
                        down.closed = true;
                        progress = true;
                        let _ = plain.shutdown(Shutdown::Write);
                    }
                }
                Step::Fatal => fatal = true,
            }
        }

        if fatal || (up.closed && down.closed) {
            break;
        }
        if !progress {
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    let _ = plain.shutdown(Shutdown::Both);
    let _ = tls.get_ref().shutdown(Shutdown::Both);
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

fn map_ftp_error(e: FtpError, context: &str) -> AppError {
    match e {
        FtpError::ConnectionError(io) => match io.kind() {
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
                AppError::timeout(format!("{context}: the connection timed out ({io})"))
            }
            _ => AppError::net(format!("{context}: {io}")),
        },
        FtpError::SecureError(msg) => AppError::protocol(format!("{context}: TLS error: {msg}")),
        FtpError::BadResponse => {
            AppError::protocol(format!("{context}: malformed response from the server"))
        }
        FtpError::InvalidAddress(e) => AppError::config(format!("{context}: invalid address: {e}")),
        FtpError::UnexpectedResponse(response) => {
            let body = response.as_string().unwrap_or_default();
            let code = response.status.code();
            match response.status {
                Status::FileUnavailable => AppError::NotFound {
                    path: context.to_string(),
                    message: format!("{context}: {code} {body}"),
                },
                Status::NotLoggedIn | Status::InvalidCredentials | Status::LoginNeedAccount => {
                    AppError::auth(format!("{context}: {code} {body}"))
                }
                Status::StoringNeedAccount
                | Status::RequestedActionNotTaken
                | Status::ExceededStorage => {
                    AppError::permission(format!("{context}: {code} {body}"))
                }
                Status::NotAvailable
                | Status::CannotOpenDataConnection
                | Status::TransferAborted
                | Status::HostUnavailable => AppError::net(format!("{context}: {code} {body}")),
                _ => AppError::protocol(format!("{context}: {code} {body}")),
            }
        }
    }
}

/// True when the server answered "I do not implement that command".
fn is_command_refusal(e: &FtpError) -> bool {
    match e {
        FtpError::UnexpectedResponse(r) => matches!(
            r.status,
            Status::BadCommand
                | Status::NotImplemented
                | Status::NotImplementedParameter
                | Status::BadArguments
                | Status::CommandNotImplemented
                | Status::FileUnavailable
        ),
        FtpError::BadResponse => true,
        _ => false,
    }
}

/// True when a failed `MKD` means "it is already there".
fn is_already_exists(e: &FtpError) -> bool {
    match e {
        FtpError::UnexpectedResponse(r) => {
            if matches!(
                r.status,
                Status::FileUnavailable
                    | Status::RequestedActionNotTaken
                    | Status::BadFilename
                    | Status::RequestFileActionIgnored
            ) {
                let body = r.as_string().unwrap_or_default().to_ascii_lowercase();
                body.contains("exist")
                    || body.contains("already")
                    || body.contains("file exists")
                    || body.is_empty()
            } else {
                false
            }
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

fn normalize_dir(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return "/".to_string();
    }
    if trimmed.len() > 1 {
        let stripped = trimmed.trim_end_matches('/');
        if stripped.is_empty() {
            return "/".to_string();
        }
        return stripped.to_string();
    }
    trimmed.to_string()
}

/// `<target>.part`, the scratch file a download is written to before it is
/// renamed into place.
fn partial_path(local: &Path) -> PathBuf {
    let mut name = local
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".part");
    match local.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(name),
        _ => PathBuf::from(name),
    }
}

// ---------------------------------------------------------------------------
// Listing parsers
// ---------------------------------------------------------------------------

struct ListingOutcome {
    files: Vec<RemoteFile>,
    /// Lines we understood, including `.`/`..` entries we then dropped.
    recognized: usize,
    unrecognized: Vec<String>,
}

fn parse_listing(lines: &[String], dir: &str, mlsd: bool, now: DateTime<Utc>) -> ListingOutcome {
    let mut files = Vec::new();
    let mut recognized = 0usize;
    let mut unrecognized = Vec::new();

    for raw in lines {
        let line = raw.trim_end_matches(['\r', '\n']);
        if line.trim().is_empty() {
            continue;
        }
        // `LIST` output on Unix servers starts with a block-count header.
        if !mlsd && line.starts_with("total ") {
            recognized += 1;
            continue;
        }

        let parsed = if mlsd {
            parse_mlsd_line(line, dir)
        } else {
            parse_list_line(line, dir, now)
        };

        match parsed {
            Some(Entry::File(f)) => {
                recognized += 1;
                files.push(f);
            }
            Some(Entry::Skipped) => recognized += 1,
            None => unrecognized.push(line.to_string()),
        }
    }

    ListingOutcome {
        files,
        recognized,
        unrecognized,
    }
}

/// A parsed line: either an entry, or a recognized entry we deliberately drop
/// (`.`, `..`, MLSD `cdir`/`pdir`).
enum Entry {
    File(RemoteFile),
    Skipped,
}

// One parameter per listing field. Grouping them into a struct would only move
// the same arguments to the construction site.
#[allow(clippy::too_many_arguments)]
fn make_entry(
    dir: &str,
    raw_name: &str,
    size: u64,
    is_dir: bool,
    is_symlink: bool,
    permissions: Option<String>,
    mode: Option<u32>,
    modified: Option<DateTime<Utc>>,
    owner: Option<String>,
    group: Option<String>,
) -> Option<Entry> {
    let (name, symlink_target) = split_symlink(raw_name, is_symlink);
    let name = name.trim().to_string();
    if name.is_empty() {
        return None;
    }
    // The server chooses these strings, and they end up joined onto a local
    // download path. Anything that is not a single plain component — `..`, a
    // separator, an absolute or drive-relative path — is dropped rather than
    // trusted. See `is_safe_entry_name` for why this matters.
    if !crate::ftp::types::is_safe_entry_name(&name) {
        tracing::warn!(
            entry = %name,
            "ignoring a directory entry whose name is not a single safe path component"
        );
        return Some(Entry::Skipped);
    }
    Some(Entry::File(RemoteFile {
        path: RemoteFile::join_path(dir, &name),
        name,
        size,
        is_dir,
        is_symlink,
        symlink_target,
        permissions,
        mode,
        modified,
        owner,
        group,
    }))
}

/// Split `link -> target` into its two halves.
fn split_symlink(raw: &str, is_symlink: bool) -> (String, Option<String>) {
    if !is_symlink {
        return (raw.to_string(), None);
    }
    match raw.find(" -> ") {
        Some(idx) => (
            raw[..idx].to_string(),
            Some(raw[idx + 4..].trim().to_string()).filter(|t| !t.is_empty()),
        ),
        None => (raw.to_string(), None),
    }
}

// -- MLSD -------------------------------------------------------------------

/// `type=file;size=1024;modify=20240102030405;UNIX.mode=0644; name`
fn parse_mlsd_line(line: &str, dir: &str) -> Option<Entry> {
    let (facts_part, name) = match line.find("; ") {
        Some(idx) => (&line[..idx + 1], &line[idx + 2..]),
        // Some servers emit the name with no facts at all.
        None => ("", line.strip_prefix(' ')?),
    };
    if name.trim().is_empty() {
        return None;
    }

    let mut entry_type: Option<String> = None;
    let mut size: u64 = 0;
    let mut modified = None;
    let mut mode = None;
    let mut owner = None;
    let mut group = None;
    let mut perm_fact = None;
    let mut saw_fact = false;

    for fact in facts_part.split(';') {
        let fact = fact.trim();
        if fact.is_empty() {
            continue;
        }
        let (key, value) = match fact.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        saw_fact = true;
        match key.to_ascii_lowercase().as_str() {
            "type" => entry_type = Some(value.to_string()),
            "size" | "sizd" => size = value.parse().unwrap_or(0),
            "modify" => modified = parse_mlsd_time(value),
            "perm" => perm_fact = Some(value.to_string()),
            "unix.mode" => mode = u32::from_str_radix(value.trim_start_matches("0o"), 8).ok(),
            "unix.owner" | "unix.ownername" | "unix.uid" => owner = Some(value.to_string()),
            "unix.group" | "unix.groupname" | "unix.gid" => group = Some(value.to_string()),
            _ => {}
        }
    }

    if !saw_fact && !facts_part.is_empty() {
        return None;
    }

    let type_lc = entry_type.unwrap_or_default().to_ascii_lowercase();
    if type_lc == "cdir" || type_lc == "pdir" {
        return Some(Entry::Skipped);
    }
    let is_dir = type_lc == "dir";
    let is_symlink = type_lc.contains("slink") || type_lc.contains("symlink");
    // `type=OS.unix=slink:/etc/passwd` carries the target in the fact itself.
    let fact_target = type_lc
        .find("slink:")
        .map(|i| entry_type_target(&type_lc, i))
        .filter(|t: &String| !t.is_empty());

    let permissions = mode.map(|m| format!("{:03o}", m & 0o777)).or(perm_fact);

    let mut entry = make_entry(
        dir,
        name,
        size,
        is_dir,
        is_symlink,
        permissions,
        mode,
        modified,
        owner,
        group,
    )?;
    if let (Entry::File(f), Some(target)) = (&mut entry, fact_target) {
        if f.symlink_target.is_none() {
            f.symlink_target = Some(target);
        }
    }
    Some(entry)
}

fn entry_type_target(type_lc: &str, idx: usize) -> String {
    type_lc[idx + "slink:".len()..].trim().to_string()
}

/// MLSD timestamps are `YYYYMMDDHHMMSS[.fff]` in UTC.
fn parse_mlsd_time(value: &str) -> Option<DateTime<Utc>> {
    let digits: String = value.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.len() < 14 {
        return None;
    }
    let year: i32 = digits[0..4].parse().ok()?;
    let month: u32 = digits[4..6].parse().ok()?;
    let day: u32 = digits[6..8].parse().ok()?;
    let hour: u32 = digits[8..10].parse().ok()?;
    let minute: u32 = digits[10..12].parse().ok()?;
    let second: u32 = digits[12..14].parse().ok()?;
    Utc.with_ymd_and_hms(year, month, day, hour, minute, second)
        .single()
}

// -- LIST -------------------------------------------------------------------

fn parse_list_line(line: &str, dir: &str, now: DateTime<Utc>) -> Option<Entry> {
    parse_unix_line(line, dir, now).or_else(|| parse_dos_line(line, dir))
}

/// Byte offset plus text for every whitespace-separated token, so a name
/// containing spaces can be recovered from the original line.
fn tokens_with_offsets(line: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for (i, ch) in line.char_indices() {
        if ch.is_whitespace() {
            if let Some(s) = start.take() {
                out.push((s, &line[s..i]));
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(s) = start {
        out.push((s, &line[s..]));
    }
    out
}

/// Unix `ls -l`:
/// `drwxr-xr-x  2 root wheel  4096 Jan  2 03:04 name with spaces`
/// Also accepts a missing group column and `--time-style=long-iso` dates.
fn parse_unix_line(line: &str, dir: &str, now: DateTime<Utc>) -> Option<Entry> {
    let tokens = tokens_with_offsets(line);
    if tokens.len() < 6 {
        return None;
    }
    let perms = tokens[0].1;
    if !looks_like_unix_perms(perms) {
        return None;
    }

    // Locate the date block, which is the only reliably shaped run of tokens.
    let mut date_idx = None;
    let mut iso = false;
    for i in 3..tokens.len() {
        if i + 2 < tokens.len()
            && month_number(tokens[i].1).is_some()
            && tokens[i + 1]
                .1
                .parse::<u32>()
                .map(|d| (1..=31).contains(&d))
                == Ok(true)
            && (looks_like_clock(tokens[i + 2].1) || looks_like_year(tokens[i + 2].1))
        {
            date_idx = Some(i);
            break;
        }
        if i + 2 < tokens.len()
            && looks_like_iso_date(tokens[i].1)
            && looks_like_clock(tokens[i + 1].1)
        {
            date_idx = Some(i);
            iso = true;
            break;
        }
    }
    let date_idx = date_idx?;
    let name_idx = if iso { date_idx + 2 } else { date_idx + 3 };
    if name_idx >= tokens.len() {
        return None;
    }

    let size = parse_size(tokens[date_idx - 1].1).unwrap_or(0);
    let owner = Some(tokens[2].1.to_string());
    // With a group column the size sits at index 4; without one it sits at 3.
    let group = if date_idx > 4 {
        Some(tokens[3].1.to_string())
    } else {
        None
    };

    let modified = if iso {
        parse_iso_datetime(tokens[date_idx].1, tokens[date_idx + 1].1)
    } else {
        parse_unix_datetime(
            tokens[date_idx].1,
            tokens[date_idx + 1].1,
            tokens[date_idx + 2].1,
            now,
        )
    };

    let raw_name = line[tokens[name_idx].0..].trim_end();
    let kind = perms.as_bytes()[0];
    let is_dir = kind == b'd';
    let is_symlink = kind == b'l';
    let perm_chars: String = perms.chars().skip(1).take(9).collect();
    let mode = perm_string_to_mode(&perm_chars);

    make_entry(
        dir,
        raw_name,
        size,
        is_dir,
        is_symlink,
        Some(perm_chars),
        mode,
        modified,
        owner,
        group,
    )
}

fn looks_like_unix_perms(token: &str) -> bool {
    let bytes = token.as_bytes();
    if bytes.len() < 10 {
        return false;
    }
    if !matches!(bytes[0], b'-' | b'd' | b'l' | b'b' | b'c' | b'p' | b's') {
        return false;
    }
    bytes[1..10].iter().all(|b| {
        matches!(
            b,
            b'r' | b'w' | b'x' | b'-' | b's' | b'S' | b't' | b'T' | b'l'
        )
    })
}

fn looks_like_clock(token: &str) -> bool {
    let mut parts = token.split(':');
    let (Some(h), Some(m)) = (parts.next(), parts.next()) else {
        return false;
    };
    if parts.next().is_some_and(|s| s.parse::<u32>().is_err()) {
        return false;
    }
    h.len() <= 2
        && !h.is_empty()
        && h.chars().all(|c| c.is_ascii_digit())
        && m.len() == 2
        && m.chars().all(|c| c.is_ascii_digit())
}

fn looks_like_year(token: &str) -> bool {
    token.len() == 4 && token.chars().all(|c| c.is_ascii_digit())
}

fn looks_like_iso_date(token: &str) -> bool {
    let parts: Vec<&str> = token.split('-').collect();
    parts.len() == 3
        && parts[0].len() == 4
        && parts[1].len() == 2
        && parts[2].len() == 2
        && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit()))
}

fn parse_size(token: &str) -> Option<u64> {
    let cleaned: String = token.chars().filter(|c| *c != ',' && *c != '.').collect();
    cleaned.parse().ok()
}

fn month_number(token: &str) -> Option<u32> {
    let m = token.to_ascii_lowercase();
    let idx = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ]
    .iter()
    .position(|name| m.starts_with(name))?;
    if m.len() > 4 && !m.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    Some(idx as u32 + 1)
}

/// `Jan  2 03:04` (current year, rolled back if that lands in the future) or
/// `Jan  2  2023`. Servers report their own local time and rarely say which
/// zone, so listings are interpreted as UTC.
fn parse_unix_datetime(
    month: &str,
    day: &str,
    last: &str,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let month = month_number(month)?;
    let day: u32 = day.parse().ok()?;
    if looks_like_year(last) {
        let year: i32 = last.parse().ok()?;
        return NaiveDate::from_ymd_opt(year, month, day)?
            .and_hms_opt(0, 0, 0)
            .map(|d| d.and_utc());
    }
    let (hour, minute) = split_clock(last)?;
    let candidate = NaiveDate::from_ymd_opt(now.year(), month, day)?
        .and_hms_opt(hour, minute, 0)?
        .and_utc();
    if candidate > now + chrono::Duration::days(1) {
        return NaiveDate::from_ymd_opt(now.year() - 1, month, day)?
            .and_hms_opt(hour, minute, 0)
            .map(|d| d.and_utc());
    }
    Some(candidate)
}

fn parse_iso_datetime(date: &str, clock: &str) -> Option<DateTime<Utc>> {
    let mut parts = date.split('-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    let (hour, minute) = split_clock(clock)?;
    NaiveDate::from_ymd_opt(year, month, day)?
        .and_hms_opt(hour, minute, 0)
        .map(|d| d.and_utc())
}

fn split_clock(token: &str) -> Option<(u32, u32)> {
    let mut parts = token.split(':');
    let hour: u32 = parts.next()?.parse().ok()?;
    let minute: u32 = parts.next()?.parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some((hour, minute))
}

fn perm_string_to_mode(perms: &str) -> Option<u32> {
    let bytes = perms.as_bytes();
    if bytes.len() != 9 {
        return None;
    }
    let mut mode = 0u32;
    for (i, chunk) in bytes.chunks(3).enumerate() {
        let shift = 6 - 3 * i as u32;
        if chunk[0] == b'r' {
            mode |= 0o4 << shift;
        }
        if chunk[1] == b'w' {
            mode |= 0o2 << shift;
        }
        match chunk[2] {
            b'x' => mode |= 0o1 << shift,
            b's' | b't' => {
                mode |= 0o1 << shift;
                mode |= special_bit(i);
            }
            b'S' | b'T' => mode |= special_bit(i),
            _ => {}
        }
    }
    Some(mode)
}

fn special_bit(group_index: usize) -> u32 {
    match group_index {
        0 => 0o4000, // setuid
        1 => 0o2000, // setgid
        _ => 0o1000, // sticky
    }
}

/// DOS / IIS:
/// `01-02-24  03:04PM       <DIR>          folder name`
/// `01-02-2024 03:04PM              1234 file.txt`
fn parse_dos_line(line: &str, dir: &str) -> Option<Entry> {
    let tokens = tokens_with_offsets(line);
    if tokens.len() < 4 {
        return None;
    }
    let (month, day, year) = parse_dos_date(tokens[0].1)?;
    let (hour, minute) = parse_dos_clock(tokens[1].1)?;
    let third = tokens[2].1;
    let (is_dir, size) = if third.eq_ignore_ascii_case("<DIR>") {
        (true, 0)
    } else {
        (false, parse_size(third)?)
    };
    let raw_name = line[tokens[3].0..].trim_end();
    let modified = NaiveDate::from_ymd_opt(year, month, day)?
        .and_hms_opt(hour, minute, 0)
        .map(|d| d.and_utc());

    make_entry(
        dir, raw_name, size, is_dir, false, None, None, modified, None, None,
    )
}

fn parse_dos_date(token: &str) -> Option<(u32, u32, i32)> {
    let parts: Vec<&str> = token.split(['-', '/']).collect();
    if parts.len() != 3 {
        return None;
    }
    let month: u32 = parts[0].parse().ok()?;
    let day: u32 = parts[1].parse().ok()?;
    let raw_year: i32 = parts[2].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = match parts[2].len() {
        2 => {
            if raw_year < 70 {
                2000 + raw_year
            } else {
                1900 + raw_year
            }
        }
        4 => raw_year,
        _ => return None,
    };
    Some((month, day, year))
}

fn parse_dos_clock(token: &str) -> Option<(u32, u32)> {
    let upper = token.to_ascii_uppercase();
    let (clock, meridiem) = if let Some(rest) = upper.strip_suffix("AM") {
        (rest, Some(false))
    } else if let Some(rest) = upper.strip_suffix("PM") {
        (rest, Some(true))
    } else {
        (upper.as_str(), None)
    };
    let mut parts = clock.split(':');
    let mut hour: u32 = parts.next()?.parse().ok()?;
    let minute: u32 = parts.next()?.parse().ok()?;
    if minute > 59 {
        return None;
    }
    match meridiem {
        Some(true) => {
            if hour > 12 {
                return None;
            }
            if hour != 12 {
                hour += 12;
            }
        }
        Some(false) => {
            if hour > 12 {
                return None;
            }
            if hour == 12 {
                hour = 0;
            }
        }
        None => {
            if hour > 23 {
                return None;
            }
        }
    }
    Some((hour, minute))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixed "now" so the year-less Unix date rule is deterministic.
    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2024, 6, 15, 12, 0, 0).unwrap()
    }

    fn parse_one(line: &str) -> RemoteFile {
        match parse_list_line(line, "/var/www", now()) {
            Some(Entry::File(f)) => f,
            Some(Entry::Skipped) => panic!("line was skipped: {line:?}"),
            None => panic!("line did not parse: {line:?}"),
        }
    }

    fn lines(input: &[&str]) -> Vec<String> {
        input.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_unix_directory_and_file() {
        let dir = parse_one("drwxr-xr-x   4 root  wheel   4096 Jan  2 03:04 assets");
        assert_eq!(dir.name, "assets");
        assert_eq!(dir.path, "/var/www/assets");
        assert!(dir.is_dir);
        assert!(!dir.is_symlink);
        assert_eq!(dir.size, 4096);
        assert_eq!(dir.owner.as_deref(), Some("root"));
        assert_eq!(dir.group.as_deref(), Some("wheel"));
        assert_eq!(dir.permissions.as_deref(), Some("rwxr-xr-x"));
        assert_eq!(dir.mode, Some(0o755));

        let file = parse_one("-rw-r--r--   1 www-data www-data 1234 Jan  2 03:04 index.html");
        assert!(!file.is_dir);
        assert_eq!(file.size, 1234);
        assert_eq!(file.mode, Some(0o644));
    }

    #[test]
    fn parses_unix_dates_with_and_without_year() {
        let recent = parse_one("-rw-r--r-- 1 u g 10 Jan  2 03:04 a.txt");
        assert_eq!(
            recent.modified,
            Some(Utc.with_ymd_and_hms(2024, 1, 2, 3, 4, 0).unwrap())
        );

        // A month/day that has not happened yet this year belongs to last year.
        let rolled = parse_one("-rw-r--r-- 1 u g 10 Dec 30 23:59 b.txt");
        assert_eq!(
            rolled.modified,
            Some(Utc.with_ymd_and_hms(2023, 12, 30, 23, 59, 0).unwrap())
        );

        let old = parse_one("-rw-r--r-- 1 u g 10 Feb 11  2019 c.txt");
        assert_eq!(
            old.modified,
            Some(Utc.with_ymd_and_hms(2019, 2, 11, 0, 0, 0).unwrap())
        );

        let iso = parse_one("-rw-r--r-- 1 u g 10 2021-03-04 05:06 d.txt");
        assert_eq!(
            iso.modified,
            Some(Utc.with_ymd_and_hms(2021, 3, 4, 5, 6, 0).unwrap())
        );
    }

    #[test]
    fn splits_symlink_name_and_target() {
        let link = parse_one("lrwxrwxrwx 1 root root 11 Jan  2 03:04 current -> releases/42");
        assert!(link.is_symlink);
        assert_eq!(link.name, "current");
        assert_eq!(link.symlink_target.as_deref(), Some("releases/42"));
        assert_eq!(link.path, "/var/www/current");
    }

    #[test]
    fn keeps_spaces_inside_names() {
        let f = parse_one("-rw-r--r-- 1 u g 10 Jan  2 03:04 my  report v2.txt");
        assert_eq!(f.name, "my  report v2.txt");
        assert_eq!(f.path, "/var/www/my  report v2.txt");

        let d = parse_one("drwxr-xr-x 2 u g 4096 Jan  2 03:04 New Folder");
        assert_eq!(d.name, "New Folder");
        assert!(d.is_dir);
    }

    #[test]
    fn handles_missing_group_column() {
        // Some servers omit the group entirely.
        let f = parse_one("-rw-r--r-- 1 alice 512 Jan  2 03:04 notes.md");
        assert_eq!(f.name, "notes.md");
        assert_eq!(f.size, 512);
        assert_eq!(f.owner.as_deref(), Some("alice"));
        assert_eq!(f.group, None);
    }

    #[test]
    fn parses_dos_listings() {
        let d = parse_one("01-02-24  03:04PM       <DIR>          Program Files");
        assert!(d.is_dir);
        assert_eq!(d.name, "Program Files");
        assert_eq!(d.size, 0);
        assert_eq!(
            d.modified,
            Some(Utc.with_ymd_and_hms(2024, 1, 2, 15, 4, 0).unwrap())
        );

        let f = parse_one("12-31-1999  11:59PM             1234 report.txt");
        assert!(!f.is_dir);
        assert_eq!(f.size, 1234);
        assert_eq!(
            f.modified,
            Some(Utc.with_ymd_and_hms(1999, 12, 31, 23, 59, 0).unwrap())
        );

        // Midnight/noon boundaries.
        let midnight = parse_one("01-01-20  12:00AM  <DIR>  midnight");
        assert_eq!(
            midnight.modified,
            Some(Utc.with_ymd_and_hms(2020, 1, 1, 0, 0, 0).unwrap())
        );
    }

    #[test]
    fn filters_dot_and_dotdot() {
        let out = parse_listing(
            &lines(&[
                "total 12",
                "drwxr-xr-x 2 u g 4096 Jan  2 03:04 .",
                "drwxr-xr-x 4 u g 4096 Jan  2 03:04 ..",
                "-rw-r--r-- 1 u g   10 Jan  2 03:04 real.txt",
            ]),
            "/srv",
            false,
            now(),
        );
        assert_eq!(out.files.len(), 1);
        assert_eq!(out.files[0].name, "real.txt");
        // "total", ".", ".." and the file were all understood.
        assert_eq!(out.recognized, 4);
        assert!(out.unrecognized.is_empty());
    }

    /// A listing is attacker-controlled input. A name that is not a single path
    /// component would be joined onto the local download directory, and an
    /// absolute one replaces that directory outright — so the parser must drop
    /// these rather than hand them to the transfer walker.
    #[test]
    fn entry_names_that_escape_a_directory_are_dropped() {
        let hostile = [
            "-rw-r--r-- 1 u g 10 Jan  2 03:04 ../../evil.exe",
            "-rw-r--r-- 1 u g 10 Jan  2 03:04 ..\\..\\evil.exe",
            "-rw-r--r-- 1 u g 10 Jan  2 03:04 C:\\Windows\\Temp\\evil.exe",
            "-rw-r--r-- 1 u g 10 Jan  2 03:04 /etc/cron.d/backdoor",
            "-rw-r--r-- 1 u g 10 Jan  2 03:04 nested/relative.txt",
        ];

        for line in hostile {
            let out = parse_listing(&lines(&[line]), "/srv", false, now());
            assert!(
                out.files.is_empty(),
                "expected {line:?} to be dropped, got {:?}",
                out.files.iter().map(|f| &f.name).collect::<Vec<_>>()
            );
            // Recognised as a well-formed listing line, then rejected on the
            // name — not reported as an unparseable format.
            assert_eq!(out.recognized, 1);
            assert!(out.unrecognized.is_empty());
        }

        // A name that merely *looks* alarming but is a single component is fine.
        let out = parse_listing(
            &lines(&["-rw-r--r-- 1 u g 10 Jan  2 03:04 ...weird..name"]),
            "/srv",
            false,
            now(),
        );
        assert_eq!(out.files.len(), 1);
        assert_eq!(out.files[0].name, "...weird..name");
    }

    #[test]
    fn unparseable_lines_are_reported_not_swallowed() {
        assert!(parse_list_line("this is not a listing at all", "/", now()).is_none());
        let out = parse_listing(
            &lines(&["<<< nonsense >>>", "also nonsense"]),
            "/",
            false,
            now(),
        );
        assert!(out.files.is_empty());
        assert_eq!(out.recognized, 0);
        assert_eq!(out.unrecognized.len(), 2);
    }

    #[test]
    fn parses_mlsd_entries() {
        let out = parse_listing(
            &lines(&[
                "type=cdir;modify=20240102030405; /srv",
                "type=pdir;modify=20240102030405; /",
                "type=dir;sizd=4096;modify=20240102030405;UNIX.mode=0755;UNIX.owner=root;UNIX.group=root; assets",
                "type=file;size=1234;modify=20231130235959;UNIX.mode=0644; index.html",
                "type=OS.unix=slink:/etc/passwd;size=11;modify=20240102030405; shortcut",
            ]),
            "/srv",
            true,
            now(),
        );
        assert_eq!(out.recognized, 5);
        assert_eq!(out.files.len(), 3);

        let dir = &out.files[0];
        assert_eq!(dir.name, "assets");
        assert!(dir.is_dir);
        assert_eq!(dir.size, 4096);
        assert_eq!(dir.mode, Some(0o755));
        assert_eq!(dir.owner.as_deref(), Some("root"));

        let file = &out.files[1];
        assert!(!file.is_dir);
        assert_eq!(file.size, 1234);
        assert_eq!(
            file.modified,
            Some(Utc.with_ymd_and_hms(2023, 11, 30, 23, 59, 59).unwrap())
        );

        let link = &out.files[2];
        assert!(link.is_symlink);
        assert_eq!(link.name, "shortcut");
        assert_eq!(link.symlink_target.as_deref(), Some("/etc/passwd"));
    }

    #[test]
    fn mlsd_names_may_contain_spaces_and_semicolon_free_facts() {
        let out = parse_listing(
            &lines(&["type=file;size=7;modify=20240102030405; two words.txt"]),
            "/",
            true,
            now(),
        );
        assert_eq!(out.files.len(), 1);
        assert_eq!(out.files[0].name, "two words.txt");
        assert_eq!(out.files[0].path, "/two words.txt");
    }

    #[test]
    fn permission_string_maps_to_mode() {
        assert_eq!(perm_string_to_mode("rwxr-xr-x"), Some(0o755));
        assert_eq!(perm_string_to_mode("rw-r--r--"), Some(0o644));
        assert_eq!(perm_string_to_mode("---------"), Some(0));
        assert_eq!(perm_string_to_mode("rwsr-xr-x"), Some(0o4755));
        assert_eq!(perm_string_to_mode("rwxrwxrwt"), Some(0o1777));
        assert_eq!(perm_string_to_mode("rwx"), None);
    }

    #[test]
    fn normalizes_directories() {
        assert_eq!(normalize_dir(""), "/");
        assert_eq!(normalize_dir("/"), "/");
        assert_eq!(normalize_dir("/var/www/"), "/var/www");
        assert_eq!(normalize_dir("  /var/www  "), "/var/www");
        assert_eq!(normalize_dir("///"), "/");
    }

    #[test]
    fn partial_download_path_is_sibling_dot_part() {
        let p = partial_path(Path::new("/tmp/dir/file.txt"));
        assert_eq!(p, PathBuf::from("/tmp/dir/file.txt.part"));
        let bare = partial_path(Path::new("file.txt"));
        assert_eq!(bare, PathBuf::from("file.txt.part"));
    }

    #[test]
    fn ftp_errors_map_to_useful_codes() {
        let missing = map_ftp_error(
            FtpError::UnexpectedResponse(suppaftp::types::Response::new(
                Status::FileUnavailable,
                b"550 No such file".to_vec(),
            )),
            "/srv/gone.txt",
        );
        assert_eq!(missing.code(), "not_found");

        let denied = map_ftp_error(
            FtpError::UnexpectedResponse(suppaftp::types::Response::new(
                Status::NotLoggedIn,
                b"530 Login incorrect".to_vec(),
            )),
            "login",
        );
        assert_eq!(denied.code(), "auth");

        let timed_out = map_ftp_error(
            FtpError::ConnectionError(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "too slow",
            )),
            "LIST",
        );
        assert_eq!(timed_out.code(), "timeout");

        let tls = map_ftp_error(FtpError::SecureError("bad cert".into()), "connect");
        assert_eq!(tls.code(), "protocol");
    }

    #[test]
    fn recognizes_mkd_already_exists() {
        let exists = FtpError::UnexpectedResponse(suppaftp::types::Response::new(
            Status::FileUnavailable,
            b"550 /srv/x: File exists".to_vec(),
        ));
        assert!(is_already_exists(&exists));

        let other = FtpError::UnexpectedResponse(suppaftp::types::Response::new(
            Status::FileUnavailable,
            b"550 Permission denied".to_vec(),
        ));
        assert!(!is_already_exists(&other));
    }

    #[test]
    fn detects_command_refusal_for_mlsd_fallback() {
        let refused = FtpError::UnexpectedResponse(suppaftp::types::Response::new(
            Status::NotImplemented,
            b"502 Command not implemented".to_vec(),
        ));
        assert!(is_command_refusal(&refused));

        let broken = FtpError::ConnectionError(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "reset",
        ));
        assert!(!is_command_refusal(&broken));
    }

    #[test]
    fn tokens_keep_their_offsets() {
        let line = "a  bb   ccc";
        let tokens = tokens_with_offsets(line);
        assert_eq!(tokens.len(), 3);
        assert_eq!(tokens[0], (0, "a"));
        assert_eq!(tokens[1], (3, "bb"));
        assert_eq!(tokens[2], (8, "ccc"));
        assert_eq!(&line[tokens[2].0..], "ccc");
    }
}
