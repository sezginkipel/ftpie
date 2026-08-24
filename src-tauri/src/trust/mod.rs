//! Trust-on-first-use store for TLS certificates and SSH host keys.
//!
//! Replaces the previous behaviour, where FTPS accepted any certificate and SSH
//! accepted any host key, with an explicit pinning model: an unknown identity
//! stops the connection and is surfaced to the user, who decides whether to
//! trust it. A *changed* identity is reported separately because it may indicate
//! a machine-in-the-middle.

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

use crate::error::{AppError, AppResult, TrustKind};
use crate::store_util::{config_path, load_json, save_json_atomic};

const STORE_FILE: &str = "known_hosts.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrustEntry {
    pub host: String,
    pub port: u16,
    pub kind: TrustKind,
    /// e.g. "ssh-ed25519", or the certificate subject for TLS.
    pub algorithm: String,
    /// Canonical "SHA256:<base64-unpadded>" form.
    pub fingerprint: String,
    pub added_at: chrono::DateTime<chrono::Utc>,
}

/// Result of checking a presented identity against the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrustVerdict {
    Trusted,
    Unknown,
    /// We have an entry for this host, but the fingerprint does not match.
    Changed {
        previous_fingerprint: String,
    },
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrustFile {
    #[serde(default)]
    entries: Vec<TrustEntry>,
}

#[derive(Debug)]
pub struct TrustStore {
    entries: Vec<TrustEntry>,
    /// Set when the file existed but could not be parsed. While true we refuse
    /// to save, so a damaged file is never overwritten with a partial view.
    load_failed: bool,
}

impl TrustStore {
    fn path() -> PathBuf {
        config_path(STORE_FILE)
    }

    /// Load the store. Never panics: a corrupt file is quarantined by
    /// `store_util::load_json` and the store starts empty but read-only.
    pub fn load() -> Self {
        match load_json::<TrustFile>(&Self::path()) {
            Ok(file) => Self {
                entries: file.entries,
                load_failed: false,
            },
            Err(e) => {
                tracing::error!(error = %e, "cannot load trust store; starting empty and read-only");
                Self {
                    entries: Vec::new(),
                    load_failed: true,
                }
            }
        }
    }

    pub fn load_failed(&self) -> bool {
        self.load_failed
    }

    fn save(&self) -> AppResult<()> {
        if self.load_failed {
            return Err(AppError::config(
                "The trusted-hosts file could not be read and is being protected from \
                 overwrite. Resolve the quarantined file in the ftpie config directory first."
                    .to_string(),
            ));
        }
        save_json_atomic(
            &Self::path(),
            &TrustFile {
                entries: self.entries.clone(),
            },
        )
    }

    fn find(&self, host: &str, port: u16, kind: TrustKind) -> Option<&TrustEntry> {
        self.entries
            .iter()
            .find(|e| e.kind == kind && e.port == port && e.host.eq_ignore_ascii_case(host))
    }

    pub fn is_trusted(
        &self,
        host: &str,
        port: u16,
        kind: TrustKind,
        fingerprint: &str,
    ) -> TrustVerdict {
        match self.find(host, port, kind) {
            None => TrustVerdict::Unknown,
            Some(entry) if entry.fingerprint == fingerprint => TrustVerdict::Trusted,
            Some(entry) => TrustVerdict::Changed {
                previous_fingerprint: entry.fingerprint.clone(),
            },
        }
    }

    /// Pin an identity, replacing any previous entry for the same host/port/kind.
    pub fn trust(&mut self, entry: TrustEntry) -> AppResult<()> {
        self.entries.retain(|e| {
            !(e.kind == entry.kind
                && e.port == entry.port
                && e.host.eq_ignore_ascii_case(&entry.host))
        });
        tracing::info!(
            host = %entry.host,
            port = entry.port,
            kind = %entry.kind,
            fingerprint = %entry.fingerprint,
            "pinning host identity"
        );
        self.entries.push(entry);
        self.save()
    }

    pub fn forget(&mut self, host: &str, port: u16, kind: TrustKind) -> AppResult<()> {
        let before = self.entries.len();
        self.entries
            .retain(|e| !(e.kind == kind && e.port == port && e.host.eq_ignore_ascii_case(host)));
        if self.entries.len() == before {
            return Err(AppError::not_found(format!("{host}:{port}")));
        }
        self.save()
    }

    pub fn list(&self) -> Vec<TrustEntry> {
        let mut out = self.entries.clone();
        out.sort_by(|a, b| a.host.cmp(&b.host).then(a.port.cmp(&b.port)));
        out
    }

    /// Build the `AppError` a protocol layer should return for a non-trusted
    /// identity, with wording that distinguishes first contact from a change.
    pub fn untrusted_error(
        host: &str,
        port: u16,
        kind: TrustKind,
        algorithm: &str,
        fingerprint: &str,
        verdict: &TrustVerdict,
    ) -> AppError {
        let (message, previous) = match verdict {
            TrustVerdict::Changed {
                previous_fingerprint,
            } => (
                format!(
                    "WARNING: the {kind} for {host}:{port} has CHANGED. This can mean the server \
                     was legitimately reinstalled, or that the connection is being intercepted. \
                     Previously trusted {previous_fingerprint}, now offered {fingerprint}. \
                     Do not continue unless you can verify the new fingerprint out of band."
                ),
                Some(previous_fingerprint.clone()),
            ),
            _ => (
                format!(
                    "{host}:{port} presented an unrecognized {kind} ({fingerprint}). \
                     Verify this fingerprint with the server operator before trusting it."
                ),
                None,
            ),
        };

        AppError::UntrustedHost {
            host: host.to_string(),
            port,
            kind,
            algorithm: algorithm.to_string(),
            fingerprint: fingerprint.to_string(),
            previous_fingerprint: previous,
            message,
        }
    }
}

/// OpenSSH-style fingerprint: `SHA256:` followed by unpadded base64 of the
/// SHA-256 digest. Applied to a certificate's DER bytes or an SSH public key's
/// wire encoding.
pub fn fingerprint_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(host: &str, fp: &str) -> TrustEntry {
        TrustEntry {
            host: host.to_string(),
            port: 22,
            kind: TrustKind::SshHostKey,
            algorithm: "ssh-ed25519".to_string(),
            fingerprint: fp.to_string(),
            added_at: chrono::Utc::now(),
        }
    }

    fn store_with(entries: Vec<TrustEntry>) -> TrustStore {
        TrustStore {
            entries,
            load_failed: false,
        }
    }

    #[test]
    fn fingerprint_is_openssh_shaped() {
        let fp = fingerprint_sha256(b"hello");
        assert!(fp.starts_with("SHA256:"));
        assert!(!fp.ends_with('='), "must be unpadded base64");
        // Same input must always produce the same fingerprint.
        assert_eq!(fp, fingerprint_sha256(b"hello"));
        assert_ne!(fp, fingerprint_sha256(b"hell0"));
    }

    #[test]
    fn unknown_host_is_not_trusted() {
        let store = store_with(vec![]);
        assert_eq!(
            store.is_trusted("a.example", 22, TrustKind::SshHostKey, "SHA256:x"),
            TrustVerdict::Unknown
        );
    }

    #[test]
    fn matching_fingerprint_is_trusted() {
        let store = store_with(vec![entry("a.example", "SHA256:x")]);
        assert_eq!(
            store.is_trusted("a.example", 22, TrustKind::SshHostKey, "SHA256:x"),
            TrustVerdict::Trusted
        );
    }

    #[test]
    fn host_matching_is_case_insensitive() {
        let store = store_with(vec![entry("A.Example", "SHA256:x")]);
        assert_eq!(
            store.is_trusted("a.example", 22, TrustKind::SshHostKey, "SHA256:x"),
            TrustVerdict::Trusted
        );
    }

    #[test]
    fn changed_fingerprint_is_reported_as_changed() {
        let store = store_with(vec![entry("a.example", "SHA256:old")]);
        assert_eq!(
            store.is_trusted("a.example", 22, TrustKind::SshHostKey, "SHA256:new"),
            TrustVerdict::Changed {
                previous_fingerprint: "SHA256:old".to_string()
            }
        );
    }

    #[test]
    fn different_port_or_kind_does_not_match() {
        let store = store_with(vec![entry("a.example", "SHA256:x")]);
        assert_eq!(
            store.is_trusted("a.example", 2222, TrustKind::SshHostKey, "SHA256:x"),
            TrustVerdict::Unknown
        );
        assert_eq!(
            store.is_trusted("a.example", 22, TrustKind::TlsCertificate, "SHA256:x"),
            TrustVerdict::Unknown
        );
    }

    #[test]
    fn changed_key_error_warns_about_interception() {
        let verdict = TrustVerdict::Changed {
            previous_fingerprint: "SHA256:old".to_string(),
        };
        let err = TrustStore::untrusted_error(
            "a.example",
            22,
            TrustKind::SshHostKey,
            "ssh-ed25519",
            "SHA256:new",
            &verdict,
        );
        match err {
            AppError::UntrustedHost {
                message,
                previous_fingerprint,
                ..
            } => {
                assert!(message.contains("CHANGED"));
                assert!(message.contains("intercepted"));
                assert_eq!(previous_fingerprint.as_deref(), Some("SHA256:old"));
            }
            other => panic!("expected UntrustedHost, got {other:?}"),
        }
    }

    #[test]
    fn read_only_store_refuses_to_save() {
        let mut store = TrustStore {
            entries: vec![],
            load_failed: true,
        };
        let err = store.trust(entry("a.example", "SHA256:x")).unwrap_err();
        assert_eq!(err.code(), "config");
    }
}
