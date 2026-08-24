//! Deploy history: what was pushed where, so a deploy can be reviewed and
//! rolled back.
//!
//! Three things were wrong with the previous implementation:
//!
//! 1. `save_record` did load → modify → save with no lock, so two concurrent
//!    deploys silently lost one record. The store now owns its file access and
//!    every mutation happens under one process-wide mutex held across the whole
//!    read-modify-write.
//! 2. Records carried placeholders: the literal string `"sftp"` as the host and
//!    `""` as the user. [`DeployRecord`] now records the real session identity,
//!    the git ref, and the exact files uploaded and deleted.
//! 3. A corrupt file was silently defaulted and then overwritten. Loading goes
//!    through `store_util::load_json`, and [`DeployHistoryStore::save`] refuses
//!    to write while the file is marked unreadable.
//!
//! The file is capped at [`MAX_RECORDS`] newest-first entries so it cannot grow
//! without bound.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::ftp::Protocol;
use crate::store_util::{config_path, load_json, save_json_atomic};

/// Newest-first cap on the on-disk history.
pub const MAX_RECORDS: usize = 200;

/// One deploy attempt, successful or not.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeployRecord {
    pub id: String,
    pub timestamp: DateTime<Utc>,
    /// Real target identity, from `SessionKind::meta()`.
    pub server_host: String,
    pub server_user: String,
    pub protocol: Protocol,
    /// Local repository this deploy came from — needed to replay a rollback.
    #[serde(default)]
    pub repo_path: String,
    /// Remote directory the paths below are relative to.
    #[serde(default)]
    pub remote_base_path: String,
    pub branch: String,
    pub commit_sha: String,
    pub files_uploaded: Vec<String>,
    pub files_deleted: Vec<String>,
    /// Total bytes transferred.
    pub bytes: u64,
    pub duration_ms: u64,
    pub success: bool,
    pub error: Option<String>,
}

impl DeployRecord {
    /// A record with a fresh id and the current timestamp; fill in the rest.
    pub fn new(
        server_host: impl Into<String>,
        server_user: impl Into<String>,
        protocol: Protocol,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: Utc::now(),
            server_host: server_host.into(),
            server_user: server_user.into(),
            protocol,
            repo_path: String::new(),
            remote_base_path: String::new(),
            branch: String::new(),
            commit_sha: String::new(),
            files_uploaded: Vec::new(),
            files_deleted: Vec::new(),
            bytes: 0,
            duration_ms: 0,
            success: false,
            error: None,
        }
    }

    pub fn file_count(&self) -> usize {
        self.files_uploaded.len() + self.files_deleted.len()
    }
}

/// Persisted shape of `deploy_history.json`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryFile {
    #[serde(default)]
    records: Vec<DeployRecord>,
}

#[derive(Debug)]
pub struct DeployHistoryStore {
    path: PathBuf,
    /// Newest first, always.
    records: Vec<DeployRecord>,
    /// Set when the file existed but could not be parsed; blocks writes.
    pub load_failed: bool,
}

impl Default for DeployHistoryStore {
    fn default() -> Self {
        Self::load()
    }
}

impl DeployHistoryStore {
    pub fn load() -> Self {
        Self::load_at(config_path("deploy_history.json"))
    }

    pub fn load_at(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        match load_json::<HistoryFile>(&path) {
            Ok(file) => {
                let mut records = file.records;
                // Tolerate a hand-edited file: normalise the ordering the rest of
                // the module relies on.
                records.sort_by_key(|r| std::cmp::Reverse(r.timestamp));
                records.truncate(MAX_RECORDS);
                Self {
                    path,
                    records,
                    load_failed: false,
                }
            }
            Err(e) => {
                tracing::error!(error = %e, "deploy history is unreadable; it will not be overwritten");
                Self {
                    path,
                    records: Vec::new(),
                    load_failed: true,
                }
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn save(&self) -> AppResult<()> {
        if self.load_failed {
            return Err(AppError::config(format!(
                "{} failed to load and was moved aside; refusing to overwrite it.",
                self.path.display()
            )));
        }
        let file = HistoryFile {
            records: self.records.clone(),
        };
        save_json_atomic(&self.path, &file)
    }

    /// Insert newest-first, enforce the cap, and persist — one operation, so a
    /// concurrent caller cannot interleave a stale write.
    pub fn push(&mut self, record: DeployRecord) -> AppResult<()> {
        self.records.insert(0, record);
        if self.records.len() > MAX_RECORDS {
            self.records.truncate(MAX_RECORDS);
        }
        self.save()
    }

    /// Newest first. `limit == 0` means "no limit".
    pub fn list(&self, limit: usize) -> Vec<DeployRecord> {
        if limit == 0 || limit >= self.records.len() {
            self.records.clone()
        } else {
            self.records[..limit].to_vec()
        }
    }

    pub fn get(&self, id: &str) -> Option<&DeployRecord> {
        self.records.iter().find(|r| r.id == id)
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Drop everything and persist the empty history.
    pub fn clear(&mut self) -> AppResult<()> {
        self.records.clear();
        self.save()
    }
}

/// Process-wide history, so every writer serialises on one lock.
fn global() -> &'static Mutex<DeployHistoryStore> {
    static STORE: OnceLock<Mutex<DeployHistoryStore>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(DeployHistoryStore::load()))
}

/// Poison-tolerant lock: a panic in one deploy must not disable the history.
fn locked() -> MutexGuard<'static, DeployHistoryStore> {
    global().lock().unwrap_or_else(|e| e.into_inner())
}

/// Append a record.
///
/// # Blocking
/// Touches the filesystem while holding the history lock. Call from
/// `spawn_blocking` on async paths.
pub fn save_record(record: DeployRecord) -> AppResult<()> {
    locked().push(record)
}

/// Newest-first history for `list_deploy_history`. `limit == 0` means all.
pub fn list(limit: usize) -> Vec<DeployRecord> {
    locked().list(limit)
}

/// Look up one record for `rollback_deploy`.
pub fn get(id: &str) -> Option<DeployRecord> {
    locked().get(id).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ftpie-dh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn record(host: &str, offset_secs: i64) -> DeployRecord {
        let mut r = DeployRecord::new(host, "deploy", Protocol::Sftp);
        r.timestamp = Utc::now() + chrono::Duration::seconds(offset_secs);
        r.branch = "main".into();
        r.commit_sha = "abc1234".into();
        r.files_uploaded = vec!["index.html".into()];
        r.success = true;
        r
    }

    #[test]
    fn records_are_newest_first() {
        let dir = temp_dir();
        let mut store = DeployHistoryStore::load_at(dir.join("h.json"));
        store.push(record("old", -60)).unwrap();
        store.push(record("mid", -30)).unwrap();
        store.push(record("new", 0)).unwrap();

        let hosts: Vec<_> = store.list(0).into_iter().map(|r| r.server_host).collect();
        assert_eq!(hosts, vec!["new", "mid", "old"]);

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn list_honours_the_limit() {
        let dir = temp_dir();
        let mut store = DeployHistoryStore::load_at(dir.join("h.json"));
        for i in 0..5 {
            store.push(record(&format!("h{i}"), i)).unwrap();
        }
        assert_eq!(store.list(2).len(), 2);
        assert_eq!(store.list(2)[0].server_host, "h4");
        assert_eq!(store.list(0).len(), 5, "0 means unlimited");
        assert_eq!(store.list(99).len(), 5);

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn cap_is_enforced_and_drops_the_oldest() {
        let dir = temp_dir();
        let mut store = DeployHistoryStore::load_at(dir.join("h.json"));
        for i in 0..(MAX_RECORDS + 25) {
            store.push(record(&format!("h{i}"), i as i64)).unwrap();
        }
        assert_eq!(store.len(), MAX_RECORDS);
        let newest = store.list(1);
        assert_eq!(newest[0].server_host, format!("h{}", MAX_RECORDS + 24));
        assert!(
            store.list(0).iter().all(|r| r.server_host != "h0"),
            "the oldest record must have been evicted"
        );

        // The cap also survives a reload.
        let reloaded = DeployHistoryStore::load_at(dir.join("h.json"));
        assert_eq!(reloaded.len(), MAX_RECORDS);

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn get_finds_a_record_by_id() {
        let dir = temp_dir();
        let mut store = DeployHistoryStore::load_at(dir.join("h.json"));
        let r = record("prod", 0);
        let id = r.id.clone();
        store.push(r).unwrap();

        assert_eq!(store.get(&id).unwrap().server_host, "prod");
        assert!(store.get("no-such-id").is_none());

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn push_persists_and_reloads() {
        let dir = temp_dir();
        let path = dir.join("h.json");
        {
            let mut store = DeployHistoryStore::load_at(&path);
            store.push(record("prod", 0)).unwrap();
        }
        let reloaded = DeployHistoryStore::load_at(&path);
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded.list(1)[0].files_uploaded, vec!["index.html"]);

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn corrupt_history_refuses_to_save() {
        let dir = temp_dir();
        let path = dir.join("h.json");
        std::fs::write(&path, b"not json").unwrap();

        let mut store = DeployHistoryStore::load_at(&path);
        assert!(store.load_failed);
        assert_eq!(store.push(record("prod", 0)).unwrap_err().code(), "config");
        assert!(!path.exists());

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn unsorted_file_is_normalised_on_load() {
        let dir = temp_dir();
        let path = dir.join("h.json");
        let file = HistoryFile {
            records: vec![record("old", -60), record("new", 0)],
        };
        save_json_atomic(&path, &file).unwrap();

        let store = DeployHistoryStore::load_at(&path);
        assert_eq!(store.list(1)[0].server_host, "new");

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn record_serializes_camel_case_with_real_fields() {
        let json = serde_json::to_value(record("prod", 0)).unwrap();
        assert_eq!(json["serverHost"], "prod");
        assert_eq!(json["serverUser"], "deploy");
        assert_eq!(json["protocol"], "sftp");
        assert!(json.get("filesUploaded").is_some());
        assert!(json.get("filesDeleted").is_some());
        assert!(json.get("durationMs").is_some());
        assert!(json.get("server_host").is_none());
    }
}
