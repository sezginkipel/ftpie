//! Structured, machine-readable errors shared by every Tauri command.
//!
//! The frontend matches on the serialized `code` field to decide how to react
//! (open the trust dialog, open the vault unlock dialog, offer a save-conflict
//! diff, and so on). Messages are English; the frontend owns localization.

use serde::Serialize;

pub type AppResult<T> = Result<T, AppError>;

/// Which kind of host identity failed verification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustKind {
    TlsCertificate,
    SshHostKey,
}

impl std::fmt::Display for TrustKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TrustKind::TlsCertificate => write!(f, "TLS certificate"),
            TrustKind::SshHostKey => write!(f, "SSH host key"),
        }
    }
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum AppError {
    /// The server presented an identity we have not pinned. The frontend must
    /// show the fingerprint and let the user decide before retrying.
    #[error("{message}")]
    UntrustedHost {
        host: String,
        port: u16,
        kind: TrustKind,
        algorithm: String,
        fingerprint: String,
        /// Present when a previously trusted fingerprint changed — a possible MITM.
        previous_fingerprint: Option<String>,
        message: String,
    },

    /// A secret was requested but the credential vault is locked.
    #[error("{message}")]
    VaultLocked { message: String },

    #[error("{message}")]
    Auth { message: String },

    #[error("{message}")]
    Network { message: String },

    #[error("{message}")]
    Timeout { message: String },

    #[error("{message}")]
    NotFound { path: String, message: String },

    #[error("{message}")]
    Permission { message: String },

    /// Optimistic-concurrency failure: the remote changed under us.
    #[error("{message}")]
    Conflict {
        message: String,
        remote_hash: Option<String>,
    },

    #[error("{message}")]
    Protocol { message: String },

    #[error("{message}")]
    Io { message: String },

    #[error("{message}")]
    Config { message: String },

    #[error("{message}")]
    Cancelled { message: String },

    #[error("{message}")]
    Internal { message: String },
}

impl AppError {
    pub fn auth(message: impl Into<String>) -> Self {
        Self::Auth {
            message: message.into(),
        }
    }

    pub fn net(message: impl Into<String>) -> Self {
        Self::Network {
            message: message.into(),
        }
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::Timeout {
            message: message.into(),
        }
    }

    pub fn not_found(path: impl Into<String>) -> Self {
        let path = path.into();
        Self::NotFound {
            message: format!("Not found: {path}"),
            path,
        }
    }

    pub fn permission(message: impl Into<String>) -> Self {
        Self::Permission {
            message: message.into(),
        }
    }

    pub fn conflict(message: impl Into<String>, remote_hash: Option<String>) -> Self {
        Self::Conflict {
            message: message.into(),
            remote_hash,
        }
    }

    pub fn protocol(message: impl Into<String>) -> Self {
        Self::Protocol {
            message: message.into(),
        }
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::Io {
            message: message.into(),
        }
    }

    pub fn config(message: impl Into<String>) -> Self {
        Self::Config {
            message: message.into(),
        }
    }

    pub fn cancelled() -> Self {
        Self::Cancelled {
            message: "Operation cancelled".to_string(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal {
            message: message.into(),
        }
    }

    pub fn vault_locked() -> Self {
        Self::VaultLocked {
            message: "The credential vault is locked. Unlock it to continue.".to_string(),
        }
    }

    /// Stable string form of the variant, handy for logging and tests.
    pub fn code(&self) -> &'static str {
        match self {
            Self::UntrustedHost { .. } => "untrusted_host",
            Self::VaultLocked { .. } => "vault_locked",
            Self::Auth { .. } => "auth",
            Self::Network { .. } => "network",
            Self::Timeout { .. } => "timeout",
            Self::NotFound { .. } => "not_found",
            Self::Permission { .. } => "permission",
            Self::Conflict { .. } => "conflict",
            Self::Protocol { .. } => "protocol",
            Self::Io { .. } => "io",
            Self::Config { .. } => "config",
            Self::Cancelled { .. } => "cancelled",
            Self::Internal { .. } => "internal",
        }
    }

    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled { .. })
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        use std::io::ErrorKind;
        match e.kind() {
            ErrorKind::NotFound => Self::NotFound {
                path: String::new(),
                message: e.to_string(),
            },
            ErrorKind::PermissionDenied => Self::Permission {
                message: e.to_string(),
            },
            ErrorKind::TimedOut | ErrorKind::WouldBlock => Self::Timeout {
                message: e.to_string(),
            },
            ErrorKind::ConnectionRefused
            | ErrorKind::ConnectionReset
            | ErrorKind::ConnectionAborted
            | ErrorKind::NotConnected
            | ErrorKind::AddrNotAvailable
            | ErrorKind::BrokenPipe => Self::Network {
                message: e.to_string(),
            },
            _ => Self::Io {
                message: e.to_string(),
            },
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::Config {
            message: format!("JSON error: {e}"),
        }
    }
}

impl From<tokio::task::JoinError> for AppError {
    fn from(e: tokio::task::JoinError) -> Self {
        if e.is_cancelled() {
            Self::cancelled()
        } else {
            Self::Internal {
                message: format!("background task failed: {e}"),
            }
        }
    }
}

/// Preserve a concrete `AppError` when it travels through `anyhow`, so protocol
/// layers can use `anyhow` internally without losing the error code.
impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        match e.downcast::<AppError>() {
            Ok(app) => app,
            Err(other) => Self::Internal {
                message: format!("{other:#}"),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_code_tag() {
        let err = AppError::vault_locked();
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "vault_locked");
        assert!(json["message"].as_str().unwrap().contains("locked"));
    }

    #[test]
    fn untrusted_host_carries_fingerprint() {
        let err = AppError::UntrustedHost {
            host: "example.com".into(),
            port: 22,
            kind: TrustKind::SshHostKey,
            algorithm: "ssh-ed25519".into(),
            fingerprint: "SHA256:abc".into(),
            previous_fingerprint: None,
            message: "unknown host key".into(),
        };
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "untrusted_host");
        assert_eq!(json["kind"], "ssh_host_key");
        assert_eq!(json["fingerprint"], "SHA256:abc");
    }

    #[test]
    fn anyhow_roundtrip_preserves_code() {
        let original = AppError::not_found("/tmp/x");
        let via_anyhow: anyhow::Error = anyhow::Error::new(original);
        let back: AppError = via_anyhow.into();
        assert_eq!(back.code(), "not_found");
    }

    #[test]
    fn io_errors_map_to_useful_codes() {
        let e: AppError = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "nope").into();
        assert_eq!(e.code(), "permission");
        let e: AppError = std::io::Error::new(std::io::ErrorKind::ConnectionReset, "reset").into();
        assert_eq!(e.code(), "network");
    }
}
