use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::Protocol;

/// Everything needed to open a session. Serialized camelCase to match the
/// frontend.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub protocol: Protocol,
    pub passive_mode: bool,
    /// Budget for TCP connect plus the security handshake.
    pub connect_timeout_secs: u64,
    /// Per-read / per-write socket timeout, applied for the life of the session.
    /// Without this a stalled server used to hang a transfer forever while
    /// holding the session lock.
    pub io_timeout_secs: u64,
    /// SFTP public-key authentication.
    pub private_key_path: Option<String>,
    pub key_passphrase: Option<String>,
}

impl Default for ConnectionConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: 21,
            username: String::new(),
            password: None,
            protocol: Protocol::Ftp,
            passive_mode: true,
            connect_timeout_secs: 15,
            io_timeout_secs: 60,
            private_key_path: None,
            key_passphrase: None,
        }
    }
}

/// Hand-written so a stray `tracing::debug!(?config)` cannot dump a password or
/// key passphrase into the log. Only their presence is reported.
impl std::fmt::Debug for ConnectionConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectionConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &redacted(self.password.as_deref()))
            .field("protocol", &self.protocol)
            .field("passive_mode", &self.passive_mode)
            .field("connect_timeout_secs", &self.connect_timeout_secs)
            .field("io_timeout_secs", &self.io_timeout_secs)
            .field("private_key_path", &self.private_key_path)
            .field("key_passphrase", &redacted(self.key_passphrase.as_deref()))
            .finish()
    }
}

/// `"<set>"` / `"<none>"` — never the value itself.
pub(crate) fn redacted(value: Option<&str>) -> &'static str {
    match value {
        Some(v) if !v.is_empty() => "<set>",
        _ => "<none>",
    }
}

impl ConnectionConfig {
    pub fn connect_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.connect_timeout_secs.clamp(1, 300))
    }

    pub fn io_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.io_timeout_secs.clamp(1, 3600))
    }

    /// Redacted form for logs — never log the password or key passphrase.
    pub fn target(&self) -> String {
        format!("{}://{}:{}", self.protocol, self.host, self.port)
    }
}

/// One remote directory entry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub is_symlink: bool,
    /// Target of a symlink, parsed out of listings that render `name -> target`.
    pub symlink_target: Option<String>,
    /// Human form, e.g. "rwxr-xr-x" from LIST or "755" from SFTP.
    pub permissions: Option<String>,
    /// Numeric mode when the server reports one, so chmod can round-trip.
    pub mode: Option<u32>,
    pub modified: Option<DateTime<Utc>>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

/// Whether a directory-entry name from a remote listing is a single, safe path
/// component.
///
/// Directory listings are attacker-controlled data: the server chooses the
/// strings, and those strings get joined onto a local download path. On Windows
/// `Path::join` **discards the base entirely** when handed an absolute path, so a
/// listing entry literally named
/// `C:\Users\me\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\x.exe`
/// would place attacker-chosen content in the victim's startup folder. `..`
/// segments escape the target directory the same way, and a name carrying a
/// separator lets the server invent subdirectories. Names are also used to build
/// remote paths for recursive delete, where a `..` segment would delete outside
/// the tree the user selected.
///
/// So a valid entry name is exactly one normal path component: no separators, no
/// drive or UNC prefix, no `.`/`..`, no NUL or control characters.
pub fn is_safe_entry_name(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." {
        return false;
    }
    if name
        .chars()
        .any(|c| c == '/' || c == '\\' || c == ':' || c == '\0' || c.is_control())
    {
        return false;
    }
    // Catches drive-relative (`C:foo`), UNC and verbatim (`\\?\`) forms as well
    // as anything else the OS does not read as a plain single component.
    let mut components = std::path::Path::new(name).components();
    matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none()
}

impl RemoteFile {
    /// Join a parent directory and an entry name into a POSIX-style remote path.
    pub fn join_path(parent: &str, name: &str) -> String {
        if parent.is_empty() {
            return format!("/{name}");
        }
        if parent.ends_with('/') {
            format!("{parent}{name}")
        } else {
            format!("{parent}/{name}")
        }
    }

    pub fn dir(parent: &str, name: impl Into<String>) -> Self {
        let name = name.into();
        Self {
            path: Self::join_path(parent, &name),
            name,
            size: 0,
            is_dir: true,
            is_symlink: false,
            symlink_target: None,
            permissions: None,
            mode: None,
            modified: None,
            owner: None,
            group: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_path_handles_trailing_slash() {
        assert_eq!(RemoteFile::join_path("/var/www", "a.txt"), "/var/www/a.txt");
        assert_eq!(
            RemoteFile::join_path("/var/www/", "a.txt"),
            "/var/www/a.txt"
        );
        assert_eq!(RemoteFile::join_path("/", "a.txt"), "/a.txt");
        assert_eq!(RemoteFile::join_path("", "a.txt"), "/a.txt");
    }

    #[test]
    fn timeouts_are_clamped_to_sane_ranges() {
        let cfg = ConnectionConfig {
            connect_timeout_secs: 0,
            io_timeout_secs: 100_000,
            ..Default::default()
        };
        assert_eq!(cfg.connect_timeout().as_secs(), 1);
        assert_eq!(cfg.io_timeout().as_secs(), 3600);
    }

    #[test]
    fn target_string_omits_credentials() {
        let cfg = ConnectionConfig {
            host: "example.com".into(),
            port: 22,
            username: "admin".into(),
            password: Some("s3cret".into()),
            protocol: Protocol::Sftp,
            ..Default::default()
        };
        let target = cfg.target();
        assert_eq!(target, "sftp://example.com:22");
        assert!(!target.contains("s3cret"));
    }

    #[test]
    fn plain_names_are_accepted() {
        for name in [
            "a.txt",
            "file with spaces.tar.gz",
            "..hidden",
            "...",
            "café-naïve.txt",
            "-",
        ] {
            assert!(is_safe_entry_name(name), "{name} should be accepted");
        }
    }

    #[test]
    fn traversal_and_absolute_names_are_rejected() {
        for name in [
            "",
            ".",
            "..",
            "../evil",
            "..\\..\\evil.exe",
            "a/b",
            "a\\b",
            "/etc/passwd",
            "C:\\Windows\\Temp\\evil.exe",
            "C:foo",
            "\\\\server\\share\\x",
            "\\\\?\\C:\\x",
            "with\0nul",
            "with\nnewline",
            "with\ttab",
        ] {
            assert!(
                !is_safe_entry_name(name),
                "{name:?} must be rejected as an entry name"
            );
        }
    }

    #[test]
    // Joining an absolute path is exactly the hazard under test here.
    #[allow(clippy::join_absolute_paths)]
    fn an_absolute_name_would_otherwise_replace_the_download_directory() {
        // The exact behaviour that makes rejection necessary: joining an
        // absolute name throws the base path away.
        let base = std::path::Path::new("/downloads/site");
        let joined = base.join("/etc/cron.d/backdoor");
        assert_ne!(
            joined,
            std::path::Path::new("/downloads/site/etc/cron.d/backdoor")
        );
        assert!(!is_safe_entry_name("/etc/cron.d/backdoor"));
    }

    #[test]
    fn remote_file_serializes_camel_case() {
        let f = RemoteFile::dir("/var", "www");
        let json = serde_json::to_value(&f).unwrap();
        assert!(json.get("isDir").is_some());
        assert!(json.get("symlinkTarget").is_some());
        assert!(json.get("is_dir").is_none());
    }
}
