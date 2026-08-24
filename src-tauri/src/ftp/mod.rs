use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub mod client;
pub mod types;

pub use client::FtpSession;
pub use types::{ConnectionConfig, RemoteFile};

/// Transport protocols ftpie actually implements.
///
/// WebDAV and S3 were previously listed here but fell through to a plaintext FTP
/// handshake, which leaked credentials to whatever answered on the port. They are
/// removed until real backends exist.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Ftp,
    Ftps,
    #[serde(rename = "ftps_implicit")]
    FtpsImplicit,
    Sftp,
}

impl Protocol {
    pub fn default_port(self) -> u16 {
        match self {
            Protocol::Ftp | Protocol::Ftps => 21,
            Protocol::FtpsImplicit => 990,
            Protocol::Sftp => 22,
        }
    }

    /// Whether traffic is encrypted in transit.
    pub fn is_secure(self) -> bool {
        !matches!(self, Protocol::Ftp)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Protocol::Ftp => "ftp",
            Protocol::Ftps => "ftps",
            Protocol::FtpsImplicit => "ftps_implicit",
            Protocol::Sftp => "sftp",
        }
    }

    pub fn parse(s: &str) -> AppResult<Protocol> {
        match s.trim().to_ascii_lowercase().as_str() {
            "ftp" => Ok(Protocol::Ftp),
            "ftps" | "ftps_explicit" => Ok(Protocol::Ftps),
            "ftps_implicit" | "ftpsimplicit" => Ok(Protocol::FtpsImplicit),
            "sftp" => Ok(Protocol::Sftp),
            "webdav" | "s3" => Err(AppError::config(format!(
                "Protocol '{s}' is not supported by this build. Supported: ftp, ftps, \
                 ftps_implicit, sftp."
            ))),
            other => Err(AppError::config(format!("Unknown protocol: '{other}'"))),
        }
    }
}

impl std::fmt::Display for Protocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_protocols() {
        assert_eq!(Protocol::parse("ftp").unwrap(), Protocol::Ftp);
        assert_eq!(Protocol::parse("FTPS").unwrap(), Protocol::Ftps);
        assert_eq!(
            Protocol::parse("ftps_implicit").unwrap(),
            Protocol::FtpsImplicit
        );
        assert_eq!(Protocol::parse(" sftp ").unwrap(), Protocol::Sftp);
    }

    #[test]
    fn rejects_removed_protocols_instead_of_falling_back_to_ftp() {
        for name in ["webdav", "s3"] {
            let err = Protocol::parse(name).unwrap_err();
            assert_eq!(err.code(), "config");
        }
    }

    #[test]
    fn rejects_unknown_protocol() {
        assert_eq!(Protocol::parse("gopher").unwrap_err().code(), "config");
    }

    #[test]
    fn default_ports_match_the_specs() {
        assert_eq!(Protocol::Ftp.default_port(), 21);
        assert_eq!(Protocol::Ftps.default_port(), 21);
        assert_eq!(Protocol::FtpsImplicit.default_port(), 990);
        assert_eq!(Protocol::Sftp.default_port(), 22);
    }

    #[test]
    fn only_plain_ftp_is_insecure() {
        assert!(!Protocol::Ftp.is_secure());
        assert!(Protocol::Ftps.is_secure());
        assert!(Protocol::FtpsImplicit.is_secure());
        assert!(Protocol::Sftp.is_secure());
    }

    #[test]
    fn serde_roundtrip_uses_wire_names() {
        let json = serde_json::to_string(&Protocol::FtpsImplicit).unwrap();
        assert_eq!(json, "\"ftps_implicit\"");
        let back: Protocol = serde_json::from_str(&json).unwrap();
        assert_eq!(back, Protocol::FtpsImplicit);
    }
}
