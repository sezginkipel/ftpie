//! Saved connections ("bookmarks") and their credentials.
//!
//! Two invariants drive the design:
//!
//! 1. **Credentials only ever move through the [`Vault`].** A bookmark password
//!    is encrypted with the vault key under the AAD context
//!    `"ftpie:bookmark:<id>"`, so a stored blob cannot be replayed into a
//!    different bookmark. Storing a password while the vault is locked is
//!    [`AppError::VaultLocked`] — there is no empty-master-password fallback.
//! 2. **A damaged store is never overwritten.** `bookmarks.json` is read with
//!    `store_util::load_json`, which quarantines an unparseable file. When that
//!    happens the store comes up empty *and* `load_failed` is set, and [`BookmarkStore::save`]
//!    refuses to run — so a single bad byte can no longer turn into permanent
//!    data loss on the next write.
//!
//! A third rule governs the IPC boundary: **ciphertext never leaves the
//! backend.** [`Bookmark`] serializes its encrypted password for
//! `bookmarks.json`, but every command returns a [`BookmarkView`], which carries
//! a derived `hasPassword` flag in its place.
//!
//! Export archives are different: they travel to another machine where the vault
//! key does not exist, so they are encrypted with an explicit user-supplied
//! passphrase (see [`BookmarkStore::export_encrypted`]).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::crypto::{self, EncryptedBlob};
use crate::error::{AppError, AppResult};
use crate::ftp::{ConnectionConfig, Protocol};
use crate::store_util::{config_path, load_json, save_json_atomic};
use crate::vault::{bookmark_context, RekeySecrets, Vault, VaultCipher};

/// AAD context for a portable export archive.
const EXPORT_CONTEXT: &str = "ftpie:bookmark-export:v1";
/// Format marker inside an export archive.
const EXPORT_VERSION: u8 = 1;

/// One saved connection. Everything needed to rebuild a [`ConnectionConfig`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub protocol: Protocol,
    pub remote_path: String,
    pub local_path: Option<String>,
    /// SFTP private key, when this bookmark authenticates with a key.
    #[serde(default)]
    pub private_key_path: Option<String>,
    /// FTP passive mode override; `None` means "use the default (passive)".
    #[serde(default)]
    pub passive_mode: Option<bool>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub created_at: String,
    /// Vault-encrypted password. Absent when the bookmark has no stored secret.
    ///
    /// This serializes only *to disk*. Everything handed to the frontend goes
    /// through [`BookmarkView`], which drops the blob and exposes a derived
    /// `hasPassword` flag instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypted_password: Option<EncryptedBlob>,
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
            protocol,
            remote_path: "/".to_string(),
            local_path: None,
            private_key_path: None,
            passive_mode: None,
            tags: Vec::new(),
            created_at: chrono::Utc::now().to_rfc3339(),
            encrypted_password: None,
        }
    }

    /// AAD context binding this bookmark's secret to this bookmark's identity.
    pub fn crypto_context(&self) -> String {
        bookmark_context(&self.id)
    }

    /// Encrypt and store `password`.
    ///
    /// Returns [`AppError::VaultLocked`] when the vault is locked. This is the
    /// only way a bookmark password is ever written.
    pub fn set_password(&mut self, vault: &Vault, password: &str) -> AppResult<()> {
        let context = self.crypto_context();
        self.encrypted_password = Some(vault.encrypt(password, &context)?);
        Ok(())
    }

    pub fn clear_password(&mut self) {
        self.encrypted_password = None;
    }

    pub fn has_password(&self) -> bool {
        self.encrypted_password.is_some()
    }

    /// Decrypt the stored password, if there is one.
    ///
    /// `Ok(None)` means "no password saved"; a locked vault is an error, not a
    /// silent `None`, so the UI can prompt for an unlock instead of attempting an
    /// anonymous login.
    pub fn password(&self, vault: &Vault) -> AppResult<Option<String>> {
        match self.encrypted_password.as_ref() {
            None => Ok(None),
            Some(blob) => {
                let context = self.crypto_context();
                Ok(Some(vault.decrypt(blob, &context)?))
            }
        }
    }

    /// Build a connection config from this bookmark plus an already-decrypted
    /// password. Timeouts come from [`ConnectionConfig::default`].
    pub fn to_connection_config(&self, password: Option<String>) -> ConnectionConfig {
        let defaults = ConnectionConfig::default();
        ConnectionConfig {
            host: self.host.clone(),
            port: if self.port == 0 {
                self.protocol.default_port()
            } else {
                self.port
            },
            username: self.username.clone(),
            password,
            protocol: self.protocol,
            passive_mode: self.passive_mode.unwrap_or(defaults.passive_mode),
            connect_timeout_secs: defaults.connect_timeout_secs,
            io_timeout_secs: defaults.io_timeout_secs,
            private_key_path: self.private_key_path.clone(),
            key_passphrase: None,
        }
    }

    /// Decrypt the password and produce a ready-to-use connection config.
    pub fn connection_config(&self, vault: &Vault) -> AppResult<ConnectionConfig> {
        let password = self.password(vault)?;
        Ok(self.to_connection_config(password))
    }
}

/// A bookmark as the **frontend** sees it.
///
/// [`Bookmark`] itself still carries `encrypted_password` because that is what
/// `bookmarks.json` has to persist, but the renderer has no business seeing a
/// credential blob: it used to receive the ciphertext, salt and nonce of every
/// stored password on `list_bookmarks`, which turned any webview scripting bug
/// into a credential exfiltration and leaked "this bookmark has a secret" even
/// while the vault was locked. The one thing the UI actually needs is the
/// derived [`Self::has_password`] flag, so that is the only thing it gets.
///
/// This type is serialize-only and deliberately has no `Deserialize`: nothing
/// coming *from* the frontend may name a stored secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkView {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub protocol: Protocol,
    pub remote_path: String,
    pub local_path: Option<String>,
    pub private_key_path: Option<String>,
    pub passive_mode: Option<bool>,
    pub tags: Vec<String>,
    pub created_at: String,
    /// True when a password is stored for this bookmark. Derived; the blob
    /// itself never crosses the IPC boundary.
    pub has_password: bool,
}

impl From<&Bookmark> for BookmarkView {
    fn from(b: &Bookmark) -> Self {
        Self {
            id: b.id.clone(),
            name: b.name.clone(),
            host: b.host.clone(),
            port: b.port,
            username: b.username.clone(),
            protocol: b.protocol,
            remote_path: b.remote_path.clone(),
            local_path: b.local_path.clone(),
            private_key_path: b.private_key_path.clone(),
            passive_mode: b.passive_mode,
            tags: b.tags.clone(),
            created_at: b.created_at.clone(),
            has_password: b.has_password(),
        }
    }
}

impl From<Bookmark> for BookmarkView {
    fn from(b: Bookmark) -> Self {
        Self::from(&b)
    }
}

/// Persisted shape of `bookmarks.json`. Kept separate from the in-memory store
/// so runtime-only state (path, `load_failed`) can never leak into the file.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookmarkFile {
    #[serde(default)]
    bookmarks: Vec<Bookmark>,
}

/// A bookmark as it appears inside a portable export archive: the password is
/// plaintext *inside* the passphrase-encrypted envelope, because the receiving
/// machine has no access to this machine's vault key.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableBookmark {
    name: String,
    host: String,
    port: u16,
    username: String,
    protocol: Protocol,
    remote_path: String,
    local_path: Option<String>,
    #[serde(default)]
    private_key_path: Option<String>,
    #[serde(default)]
    passive_mode: Option<bool>,
    #[serde(default)]
    tags: Vec<String>,
    created_at: String,
    /// Original id, kept only so an import can report collisions.
    id: String,
    #[serde(default)]
    password: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportPayload {
    v: u8,
    bookmarks: Vec<PortableBookmark>,
}

/// Outcome of an import, so the UI can tell the user what actually happened.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// Entries appended to the store.
    pub added: usize,
    /// Entries recognised as already present and left alone.
    pub skipped: usize,
    /// Of the added entries, how many had to be given a fresh id because the
    /// incoming id collided with an existing one.
    pub ids_regenerated: usize,
}

#[derive(Debug)]
pub struct BookmarkStore {
    path: PathBuf,
    pub bookmarks: Vec<Bookmark>,
    /// Set when the file existed but could not be parsed. While set, [`Self::save`]
    /// refuses to write so the quarantined original stays the only truth.
    pub load_failed: bool,
}

impl Default for BookmarkStore {
    fn default() -> Self {
        Self {
            path: config_path("bookmarks.json"),
            bookmarks: Vec::new(),
            load_failed: false,
        }
    }
}

impl BookmarkStore {
    /// Load from the default location. Never fails; a corrupt file leaves the
    /// store empty and read-only.
    pub fn load() -> Self {
        Self::load_at(config_path("bookmarks.json"))
    }

    pub fn load_at(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        match load_json::<BookmarkFile>(&path) {
            Ok(file) => Self {
                path,
                bookmarks: file.bookmarks,
                load_failed: false,
            },
            Err(e) => {
                tracing::error!(error = %e, "bookmark store is unreadable; it will not be overwritten");
                Self {
                    path,
                    bookmarks: Vec::new(),
                    load_failed: true,
                }
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Persist atomically. Refuses to run while the store is marked read-only.
    pub fn save(&self) -> AppResult<()> {
        if self.load_failed {
            return Err(AppError::config(format!(
                "{} failed to load and was moved aside; refusing to overwrite it with an empty \
                 store. Restore or delete the quarantined file, then restart.",
                self.path.display()
            )));
        }
        let file = BookmarkFile {
            bookmarks: self.bookmarks.clone(),
        };
        save_json_atomic(&self.path, &file)
    }

    pub fn list(&self) -> &[Bookmark] {
        &self.bookmarks
    }

    pub fn add(&mut self, bookmark: Bookmark) {
        self.bookmarks.push(bookmark);
    }

    pub fn get(&self, id: &str) -> Option<&Bookmark> {
        self.bookmarks.iter().find(|b| b.id == id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut Bookmark> {
        self.bookmarks.iter_mut().find(|b| b.id == id)
    }

    /// Replace an existing entry wholesale. Returns false when the id is unknown.
    pub fn update(&mut self, bookmark: Bookmark) -> bool {
        match self.bookmarks.iter_mut().find(|b| b.id == bookmark.id) {
            Some(existing) => {
                *existing = bookmark;
                true
            }
            None => false,
        }
    }

    pub fn delete(&mut self, id: &str) -> bool {
        let before = self.bookmarks.len();
        self.bookmarks.retain(|b| b.id != id);
        self.bookmarks.len() < before
    }

    /// Encrypt every bookmark, passwords included, under `passphrase`.
    ///
    /// The passphrase is deliberately independent of the master password: the
    /// archive is meant to be carried to another machine, which has no copy of
    /// this vault's key. Passwords are decrypted from the vault first, so an
    /// unlocked vault is required whenever any bookmark holds a secret.
    ///
    /// # Blocking
    /// Runs Argon2id — call from `spawn_blocking`.
    pub fn export_encrypted(&self, vault: &Vault, passphrase: &str) -> AppResult<String> {
        if passphrase.chars().count() < 8 {
            return Err(AppError::config(
                "the export passphrase must be at least 8 characters".to_string(),
            ));
        }

        let mut portable = Vec::with_capacity(self.bookmarks.len());
        for b in &self.bookmarks {
            portable.push(PortableBookmark {
                name: b.name.clone(),
                host: b.host.clone(),
                port: b.port,
                username: b.username.clone(),
                protocol: b.protocol,
                remote_path: b.remote_path.clone(),
                local_path: b.local_path.clone(),
                private_key_path: b.private_key_path.clone(),
                passive_mode: b.passive_mode,
                tags: b.tags.clone(),
                created_at: b.created_at.clone(),
                id: b.id.clone(),
                password: b.password(vault)?,
            });
        }

        let payload = ExportPayload {
            v: EXPORT_VERSION,
            bookmarks: portable,
        };
        let json = serde_json::to_vec(&payload)?;
        let blob = crypto::encrypt_with_password(&json, passphrase, EXPORT_CONTEXT)?;
        Ok(serde_json::to_string_pretty(&blob)?)
    }

    /// Merge an archive produced by [`Self::export_encrypted`].
    ///
    /// Never clobbers an existing entry: an incoming id that collides gets a
    /// fresh uuid, and an entry that already exists (same protocol, host, port,
    /// user and name) is skipped rather than duplicated. Passwords are
    /// re-encrypted under this machine's vault, so an unlocked vault is required
    /// when the archive carries any.
    ///
    /// # Blocking
    /// Runs Argon2id — call from `spawn_blocking`.
    pub fn import_encrypted(
        &mut self,
        archive_json: &str,
        passphrase: &str,
        vault: &Vault,
    ) -> AppResult<ImportReport> {
        let blob: EncryptedBlob = serde_json::from_str(archive_json).map_err(|e| {
            AppError::config(format!("this file is not an ftpie bookmark archive: {e}"))
        })?;
        let plain = crypto::decrypt_with_password(&blob, passphrase, EXPORT_CONTEXT)?;
        let payload: ExportPayload = serde_json::from_slice(&plain)
            .map_err(|e| AppError::config(format!("the archive contents are not readable: {e}")))?;
        if payload.v != EXPORT_VERSION {
            return Err(AppError::config(format!(
                "unsupported archive version {} (this build understands {EXPORT_VERSION})",
                payload.v
            )));
        }

        let mut report = ImportReport::default();
        for incoming in payload.bookmarks {
            if self.bookmarks.iter().any(|b| {
                b.protocol == incoming.protocol
                    && b.host == incoming.host
                    && b.port == incoming.port
                    && b.username == incoming.username
                    && b.name == incoming.name
            }) {
                report.skipped += 1;
                continue;
            }

            let collides = self.bookmarks.iter().any(|b| b.id == incoming.id);
            if collides {
                report.ids_regenerated += 1;
            }
            let id = if collides {
                uuid::Uuid::new_v4().to_string()
            } else {
                incoming.id.clone()
            };

            let mut bookmark = Bookmark {
                id,
                name: incoming.name,
                host: incoming.host,
                port: incoming.port,
                username: incoming.username,
                protocol: incoming.protocol,
                remote_path: incoming.remote_path,
                local_path: incoming.local_path,
                private_key_path: incoming.private_key_path,
                passive_mode: incoming.passive_mode,
                tags: incoming.tags,
                created_at: incoming.created_at,
                encrypted_password: None,
            };
            if let Some(password) = incoming.password {
                // A locked vault must not silently drop the credential.
                bookmark.set_password(vault, &password)?;
            }
            self.bookmarks.push(bookmark);
            report.added += 1;
        }

        if report.added > 0 {
            self.save()?;
        }
        Ok(report)
    }
}

/// Re-key every stored bookmark password when the master password changes.
///
/// Called by [`Vault::change_password`]. All-or-nothing: the whole vector is
/// rebuilt in memory and only then written with a single atomic save.
impl RekeySecrets for BookmarkStore {
    fn rekey(&mut self, old: &VaultCipher<'_>, new: &VaultCipher<'_>) -> AppResult<()> {
        let mut rebuilt = self.bookmarks.clone();
        for bookmark in &mut rebuilt {
            let Some(blob) = bookmark.encrypted_password.as_ref() else {
                continue;
            };
            let context = bookmark_context(&bookmark.id);
            let plain = old.decrypt(blob, &context)?;
            bookmark.encrypted_password = Some(new.encrypt(&plain, &context)?);
        }
        let previous = std::mem::replace(&mut self.bookmarks, rebuilt);
        if let Err(e) = self.save() {
            // Keep memory and disk consistent if the write failed.
            self.bookmarks = previous;
            return Err(e);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ftpie-bm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn unlocked_vault(dir: &Path) -> Vault {
        let mut vault = Vault::load_at(dir.join("vault.json"));
        vault.initialize("hunter2hunter2").unwrap();
        vault
    }

    fn sample(name: &str) -> Bookmark {
        Bookmark::new(name, "example.com", 22, "deploy", Protocol::Sftp)
    }

    #[test]
    fn password_roundtrips_through_the_vault() {
        let dir = temp_dir();
        let vault = unlocked_vault(&dir);
        let mut bookmark = sample("prod");

        bookmark.set_password(&vault, "s3cret").unwrap();
        assert!(bookmark.has_password());
        assert_eq!(
            bookmark.password(&vault).unwrap().as_deref(),
            Some("s3cret")
        );

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn storing_a_password_while_locked_is_vault_locked() {
        let dir = temp_dir();
        let mut vault = unlocked_vault(&dir);
        vault.lock();

        let mut bookmark = sample("prod");
        let err = bookmark.set_password(&vault, "s3cret").unwrap_err();
        assert_eq!(err.code(), "vault_locked");
        assert!(!bookmark.has_password());

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn reading_a_password_while_locked_is_vault_locked_not_none() {
        let dir = temp_dir();
        let mut vault = unlocked_vault(&dir);
        let mut bookmark = sample("prod");
        bookmark.set_password(&vault, "s3cret").unwrap();
        vault.lock();

        assert_eq!(
            bookmark.password(&vault).unwrap_err().code(),
            "vault_locked"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn wrong_master_password_cannot_read_a_stored_secret() {
        let dir = temp_dir();
        let mut vault = unlocked_vault(&dir);
        let mut bookmark = sample("prod");
        bookmark.set_password(&vault, "s3cret").unwrap();
        vault.lock();

        assert_eq!(vault.unlock("wrong-password").unwrap_err().code(), "auth");
        assert!(bookmark.password(&vault).is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_blob_cannot_be_moved_to_another_bookmark() {
        let dir = temp_dir();
        let vault = unlocked_vault(&dir);
        let mut first = sample("prod");
        first.set_password(&vault, "s3cret").unwrap();

        // Splice the blob into a different bookmark: the AAD context no longer
        // matches, so it must not decrypt.
        let mut second = sample("staging");
        second.encrypted_password = first.encrypted_password.clone();
        assert!(second.password(&vault).is_err());

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn corrupt_store_loads_empty_and_refuses_to_save() {
        let dir = temp_dir();
        let path = dir.join("bookmarks.json");
        std::fs::write(&path, b"{ not json at all").unwrap();

        let mut store = BookmarkStore::load_at(&path);
        assert!(store.load_failed);
        assert!(store.bookmarks.is_empty());

        store.add(sample("prod"));
        let err = store.save().unwrap_err();
        assert_eq!(err.code(), "config");
        assert!(
            !path.exists(),
            "the quarantined original must not be recreated"
        );

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn save_and_reload_roundtrips() {
        let dir = temp_dir();
        let path = dir.join("bookmarks.json");
        let mut store = BookmarkStore::load_at(&path);
        store.add(sample("prod"));
        store.save().unwrap();

        let reloaded = BookmarkStore::load_at(&path);
        assert!(!reloaded.load_failed);
        assert_eq!(reloaded.list().len(), 1);
        assert_eq!(reloaded.list()[0].name, "prod");

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn bookmark_serializes_camel_case() {
        let json = serde_json::to_value(sample("prod")).unwrap();
        assert!(json.get("remotePath").is_some());
        assert!(json.get("privateKeyPath").is_some());
        assert!(json.get("passiveMode").is_some());
        assert!(json.get("remote_path").is_none());
    }

    #[test]
    fn connection_config_carries_the_full_connection() {
        let dir = temp_dir();
        let vault = unlocked_vault(&dir);
        let mut bookmark = sample("prod");
        bookmark.private_key_path = Some("C:/keys/id_ed25519".into());
        bookmark.passive_mode = Some(false);
        bookmark.set_password(&vault, "s3cret").unwrap();

        let cfg = bookmark.connection_config(&vault).unwrap();
        assert_eq!(cfg.host, "example.com");
        assert_eq!(cfg.port, 22);
        assert_eq!(cfg.protocol, Protocol::Sftp);
        assert_eq!(cfg.password.as_deref(), Some("s3cret"));
        assert_eq!(cfg.private_key_path.as_deref(), Some("C:/keys/id_ed25519"));
        assert!(!cfg.passive_mode);

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn zero_port_falls_back_to_the_protocol_default() {
        let mut bookmark = sample("prod");
        bookmark.port = 0;
        bookmark.protocol = Protocol::FtpsImplicit;
        assert_eq!(bookmark.to_connection_config(None).port, 990);
    }

    #[test]
    fn export_import_roundtrips_with_a_passphrase() {
        let dir = temp_dir();
        let vault = unlocked_vault(&dir);

        let mut source = BookmarkStore::load_at(dir.join("source.json"));
        let mut b = sample("prod");
        b.set_password(&vault, "s3cret").unwrap();
        source.add(b);

        let archive = source
            .export_encrypted(&vault, "export-passphrase")
            .unwrap();

        let mut target = BookmarkStore::load_at(dir.join("target.json"));
        let report = target
            .import_encrypted(&archive, "export-passphrase", &vault)
            .unwrap();
        assert_eq!(report.added, 1);
        assert_eq!(report.skipped, 0);
        assert_eq!(
            target.list()[0].password(&vault).unwrap().as_deref(),
            Some("s3cret"),
            "the password must be re-encrypted under this machine's vault"
        );

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn import_with_the_wrong_passphrase_fails() {
        let dir = temp_dir();
        let vault = unlocked_vault(&dir);
        let mut source = BookmarkStore::load_at(dir.join("source.json"));
        source.add(sample("prod"));
        let archive = source
            .export_encrypted(&vault, "export-passphrase")
            .unwrap();

        let mut target = BookmarkStore::load_at(dir.join("target.json"));
        assert!(target
            .import_encrypted(&archive, "wrong-passphrase", &vault)
            .is_err());
        assert!(target.list().is_empty());

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn import_regenerates_colliding_ids_instead_of_clobbering() {
        let dir = temp_dir();
        let vault = unlocked_vault(&dir);

        // Export one bookmark, then import it into a store that already holds a
        // *different* bookmark reusing the same id.
        let mut source = BookmarkStore::load_at(dir.join("source.json"));
        let mut exported = sample("prod");
        exported.set_password(&vault, "incoming").unwrap();
        let shared_id = exported.id.clone();
        source.add(exported);
        let archive = source
            .export_encrypted(&vault, "export-passphrase")
            .unwrap();

        let mut target = BookmarkStore::load_at(dir.join("target.json"));
        let mut existing = Bookmark::new("local", "other.host", 21, "anon", Protocol::Ftp);
        existing.id = shared_id.clone();
        existing.set_password(&vault, "keep-me").unwrap();
        target.add(existing);

        let report = target
            .import_encrypted(&archive, "export-passphrase", &vault)
            .unwrap();
        assert_eq!(report.added, 1);
        assert_eq!(report.ids_regenerated, 1);
        assert_eq!(target.list().len(), 2);

        // The pre-existing entry is untouched, including its secret.
        let kept = target.get(&shared_id).unwrap();
        assert_eq!(kept.name, "local");
        assert_eq!(kept.password(&vault).unwrap().as_deref(), Some("keep-me"));

        // The imported entry got a fresh id and still decrypts under it.
        let imported = target
            .list()
            .iter()
            .find(|b| b.name == "prod")
            .expect("imported entry present");
        assert_ne!(imported.id, shared_id);
        assert_eq!(
            imported.password(&vault).unwrap().as_deref(),
            Some("incoming")
        );

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn importing_the_same_archive_twice_skips_duplicates() {
        let dir = temp_dir();
        let vault = unlocked_vault(&dir);
        let mut source = BookmarkStore::load_at(dir.join("source.json"));
        source.add(sample("prod"));
        let archive = source
            .export_encrypted(&vault, "export-passphrase")
            .unwrap();

        let mut target = BookmarkStore::load_at(dir.join("target.json"));
        assert_eq!(
            target
                .import_encrypted(&archive, "export-passphrase", &vault)
                .unwrap()
                .added,
            1
        );
        let second = target
            .import_encrypted(&archive, "export-passphrase", &vault)
            .unwrap();
        assert_eq!(second.added, 0);
        assert_eq!(second.skipped, 1);
        assert_eq!(target.list().len(), 1);

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn rekey_moves_every_password_to_the_new_key() {
        let dir = temp_dir();
        let mut vault = unlocked_vault(&dir);

        let mut store = BookmarkStore::load_at(dir.join("bookmarks.json"));
        let mut a = sample("prod");
        a.set_password(&vault, "pw-a").unwrap();
        let mut b = Bookmark::new("staging", "stg.example.com", 21, "ftp", Protocol::Ftps);
        b.set_password(&vault, "pw-b").unwrap();
        store.add(a);
        store.add(b);
        store.save().unwrap();

        vault
            .change_password("hunter2hunter2", "correct-horse-battery", &mut store)
            .unwrap();

        vault.lock();
        vault.unlock("correct-horse-battery").unwrap();
        assert_eq!(
            store.list()[0].password(&vault).unwrap().as_deref(),
            Some("pw-a")
        );
        assert_eq!(
            store.list()[1].password(&vault).unwrap().as_deref(),
            Some("pw-b")
        );

        // And the change survives a reload from disk.
        let reloaded = BookmarkStore::load_at(dir.join("bookmarks.json"));
        assert_eq!(
            reloaded.list()[0].password(&vault).unwrap().as_deref(),
            Some("pw-a")
        );

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn crud_operations_behave() {
        let dir = temp_dir();
        let mut store = BookmarkStore::load_at(dir.join("bookmarks.json"));
        let bookmark = sample("prod");
        let id = bookmark.id.clone();
        store.add(bookmark);

        assert!(store.get(&id).is_some());
        let mut edited = store.get(&id).unwrap().clone();
        edited.name = "renamed".into();
        assert!(store.update(edited));
        assert_eq!(store.get(&id).unwrap().name, "renamed");

        assert!(store.delete(&id));
        assert!(!store.delete(&id));
        assert!(store.list().is_empty());

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn the_frontend_view_never_carries_the_ciphertext() {
        let dir = temp_dir();
        let vault = unlocked_vault(&dir);
        let mut bookmark = sample("prod");
        bookmark.set_password(&vault, "s3cret").unwrap();

        let json = serde_json::to_value(BookmarkView::from(&bookmark)).unwrap();
        assert!(
            json.get("encryptedPassword").is_none(),
            "the credential blob must not cross the IPC boundary"
        );
        assert!(json.get("encrypted_password").is_none());
        assert_eq!(json["hasPassword"], true);
        assert_eq!(json["remotePath"], "/");

        // Nothing else got lost on the way out.
        assert_eq!(json["id"], bookmark.id);
        assert_eq!(json["host"], "example.com");
        assert_eq!(json["port"], 22);
        assert_eq!(json["protocol"], "sftp");

        // And a whole-store render leaks nothing either.
        let mut store = BookmarkStore::load_at(dir.join("bookmarks.json"));
        store.add(bookmark);
        let rendered = serde_json::to_string(
            &store
                .list()
                .iter()
                .map(BookmarkView::from)
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert!(!rendered.contains("encryptedPassword"));
        assert!(!rendered.contains("ciphertext"));

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_bookmark_without_a_password_reports_has_password_false() {
        let json = serde_json::to_value(BookmarkView::from(&sample("prod"))).unwrap();
        assert_eq!(json["hasPassword"], false);
    }

    #[test]
    fn the_on_disk_format_still_stores_the_ciphertext() {
        let dir = temp_dir();
        let vault = unlocked_vault(&dir);
        let path = dir.join("bookmarks.json");

        let mut store = BookmarkStore::load_at(&path);
        let mut bookmark = sample("prod");
        bookmark.set_password(&vault, "s3cret").unwrap();
        store.add(bookmark);
        store.save().unwrap();

        // Skipping the field on the wire must not have skipped it on disk.
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            raw.contains("encryptedPassword"),
            "persistence still needs the blob: {raw}"
        );

        let reloaded = BookmarkStore::load_at(&path);
        assert_eq!(
            reloaded.list()[0].password(&vault).unwrap().as_deref(),
            Some("s3cret")
        );

        std::fs::remove_dir_all(dir).ok();
    }
}
