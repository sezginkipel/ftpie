//! Deploy geçmişi — her deploy kaydedilir, geri alma desteklenir
//! Faz 2.5

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ── Veri Yapıları ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployRecord {
    pub id: String,
    pub timestamp: String,
    /// Deploy yapılan FTP/SFTP oturum konfigürasyonu özeti
    pub server_host: String,
    pub server_user: String,
    /// Kaynak git repo yolu
    pub repo_path: String,
    /// Uzak sunucu hedef kök dizini
    pub remote_base_path: String,
    /// Deploy sırasındaki git ref/commit (opsiyonel)
    pub git_ref: Option<String>,
    /// Özet
    pub uploaded: usize,
    pub skipped: usize,
    pub failed: usize,
    /// Detaylı dosya listesi
    pub files: Vec<DeployedFileRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployedFileRecord {
    pub local_path: String,
    pub remote_path: String,
    pub status: DeployFileStatus,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeployFileStatus {
    Done,
    Skipped,
    Failed,
}

// ── Deploy Mağazası ───────────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct DeployHistoryStore {
    /// En yeni önce sıralı
    pub records: Vec<DeployRecord>,
}

impl DeployHistoryStore {
    fn config_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("ftpie")
            .join("deploy_history.json")
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
        std::fs::write(&path, serde_json::to_string_pretty(self)?)
            .context("deploy geçmişi yazılamadı")
    }

    /// Yeni deploy kaydını ekle (maks 100 kayıt tut)
    pub fn push(&mut self, record: DeployRecord) {
        self.records.insert(0, record);
        if self.records.len() > 100 {
            self.records.truncate(100);
        }
    }

    /// ID'ye göre kayıt bul
    pub fn get(&self, id: &str) -> Option<&DeployRecord> {
        self.records.iter().find(|r| r.id == id)
    }
}

/// Deploy kaydını diske kaydet (komut handler'larından çağrılır)
pub fn save_record(record: DeployRecord) -> Result<()> {
    let mut store = DeployHistoryStore::load_or_default();
    store.push(record);
    store.save()
}
