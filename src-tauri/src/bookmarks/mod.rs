use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::crypto;
use crate::ftp::Protocol;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bookmark {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// Şifreli parola (base64-encoded EncryptedBlob JSON)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypted_password: Option<String>,
    pub protocol: Protocol,
    pub remote_path: String,
    pub local_path: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub created_at: String,
}

impl Bookmark {
    pub fn new(
        name: impl Into<String>,
        host: impl Into<String>,
        port: u16,
        username: impl Into<String>,
        protocol: Protocol,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            host: host.into(),
            port,
            username: username.into(),
            encrypted_password: None,
            protocol,
            remote_path: "/".to_string(),
            local_path: None,
            tags: vec![],
            created_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// Parolayı master password ile şifreler ve saklar
    pub fn set_password(&mut self, password: &str, master_password: &str) -> Result<()> {
        let blob = crypto::encrypt(password.as_bytes(), master_password)?;
        let json = serde_json::to_string(&blob)?;
        self.encrypted_password = Some(base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            json.as_bytes(),
        ));
        Ok(())
    }

    /// Parolayı çözer
    pub fn get_password(&self, master_password: &str) -> Result<Option<String>> {
        let Some(ref enc) = self.encrypted_password else {
            return Ok(None);
        };
        let json_bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            enc,
        )?;
        let blob: crypto::EncryptedBlob = serde_json::from_slice(&json_bytes)?;
        let plain = crypto::decrypt(&blob, master_password)?;
        Ok(Some(String::from_utf8(plain)?))
    }
}

/// Bookmark deposu — diskte şifreli JSON olarak tutulur
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct BookmarkStore {
    pub bookmarks: Vec<Bookmark>,
}

impl BookmarkStore {
    fn config_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("ftpie")
            .join("bookmarks.json")
    }

    pub fn load_or_default() -> Self {
        let path = Self::config_path();
        if path.exists() {
            std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            Self::default()
        }
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)?;
        std::fs::write(&path, json).context("cannot write bookmarks")?;
        Ok(())
    }

    pub fn add(&mut self, bookmark: Bookmark) -> &Bookmark {
        self.bookmarks.push(bookmark);
        self.bookmarks.last().unwrap()
    }

    pub fn get(&self, id: &str) -> Option<&Bookmark> {
        self.bookmarks.iter().find(|b| b.id == id)
    }

    pub fn update(&mut self, bookmark: Bookmark) -> bool {
        if let Some(existing) = self.bookmarks.iter_mut().find(|b| b.id == bookmark.id) {
            *existing = bookmark;
            true
        } else {
            false
        }
    }

    pub fn delete(&mut self, id: &str) -> bool {
        let before = self.bookmarks.len();
        self.bookmarks.retain(|b| b.id != id);
        self.bookmarks.len() < before
    }

    /// Tüm bookmark'ları şifreli JSON olarak export eder (paylaşılabilir)
    pub fn export_encrypted(&self, master_password: &str) -> Result<String> {
        let json = serde_json::to_vec(self)?;
        let blob = crypto::encrypt(&json, master_password)?;
        Ok(serde_json::to_string(&blob)?)
    }

    /// Şifreli JSON'dan import eder (mevcut bookmark'lara ekler)
    pub fn import_encrypted(&mut self, encrypted_json: &str, master_password: &str) -> Result<usize> {
        let blob: crypto::EncryptedBlob = serde_json::from_str(encrypted_json)?;
        let plain = crypto::decrypt(&blob, master_password)?;
        let imported: BookmarkStore = serde_json::from_slice(&plain)?;
        let count = imported.bookmarks.len();
        for b in imported.bookmarks {
            if self.get(&b.id).is_none() {
                self.bookmarks.push(b);
            }
        }
        Ok(count)
    }
}
