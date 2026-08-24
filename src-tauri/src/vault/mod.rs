//! The credential vault: the single gate every stored secret passes through.
//!
//! # Why this module exists
//!
//! Before it, bookmark passwords were encrypted with a key derived from an
//! **empty string** — the frontend passed `""` as the master password — so
//! anyone holding `bookmarks.json` could recover every server credential. The
//! AES-256-GCM/Argon2id primitives were fine; the key management was the hole.
//!
//! The vault closes it: there is exactly one place a key is derived, it is
//! derived from a real user-chosen master password, it lives in memory only
//! while unlocked, and it is wiped on `lock()` and on drop. There is **no code
//! path that encrypts with an empty or defaulted password** — [`crypto::derive_key`]
//! itself rejects `""`, and [`Vault::initialize`] enforces a minimum length.
//!
//! # On-disk verifier
//!
//! `config_dir()/vault.json` holds the salt plus an encrypted known constant:
//!
//! ```json
//! { "v": 1, "salt": "<base64>", "verifier": { "v": 1, "salt": "...", "nonce": "...", "ciphertext": "..." } }
//! ```
//!
//! [`Vault::unlock`] verifies a password by decrypting that constant, so a wrong
//! password is detected without touching — let alone risking — the bookmark
//! store.
//!
//! An optional `fallback` object of the same `{ salt, verifier }` shape may sit
//! alongside it while a master-password change is in flight or was interrupted;
//! see below. A file written before that field existed simply has no `fallback`,
//! and a file with nothing to fall back to does not emit one, so the format is
//! unchanged for every vault that has never had an interrupted change.
//!
//! # Blocking
//!
//! Argon2id is deliberately memory- and CPU-hard. [`Vault::initialize`],
//! [`Vault::unlock`] and [`Vault::change_password`] all run it and MUST be
//! called from `tokio::task::spawn_blocking`; running them on the async
//! executor stalls every other task for the duration of the derivation.
//! [`Vault::encrypt`] / [`Vault::decrypt`] do not derive anything and are cheap.
//!
//! # Changing the master password
//!
//! The key is derived from the password, so every secret encrypted under the old
//! key must be re-encrypted. The vault cannot reach the bookmark store (or the
//! AI key store) from here without a dependency cycle, so the caller injects it:
//!
//! 1. The command layer locks the stores it owns and passes them to
//!    [`Vault::change_password`] as a [`RekeySecrets`] implementation.
//! 2. The vault verifies `old` against the stored verifier and derives a new key
//!    under a **fresh salt**.
//! 3. It **rolls forward**: the new key is written to `vault.json` as the primary
//!    verifier *before* a single secret moves, and the key the secrets are
//!    currently under is retained in `fallback`. Both keys are on disk from this
//!    point on.
//! 4. It calls [`RekeySecrets::rekey`] with an old and a new [`VaultCipher`].
//!    The implementation walks its secrets, decrypts each with the old cipher
//!    and re-encrypts with the new one under the *same* AAD context, then
//!    persists atomically (one `save_json_atomic` for the whole file).
//! 5. Once that succeeded the vault rewrites `vault.json` without the fallback
//!    and swaps its in-memory key.
//!
//! # Why that ordering, and what an interruption looks like
//!
//! The invariant is: **at every instant, `vault.json` verifies every key that any
//! stored secret could currently be encrypted under.** No single failure can
//! therefore make a secret unreadable.
//!
//! - Step 3 fails — nothing has moved, the file is untouched, the old password
//!   works. The change simply did not happen.
//! - Step 4 fails — the file already lists both keys, so both passwords unlock
//!   and every secret is reachable with one of them. The secrets are *not* rolled
//!   back: a store may have moved before the failure, and un-moving it could fail
//!   too. That was the old double fault — the rollback re-key was the only thing
//!   keeping the secrets reachable, and when it failed the new key existed
//!   nowhere on disk and could never be reconstructed, so the advice to
//!   "re-enter the new password" was impossible to act on.
//! - Step 5 fails — the secrets are all under the new key, which is already the
//!   file's primary verifier, so the new password unlocks and reads everything.
//!   The only residue is a stale `fallback`; the next successful change drops it.
//!
//! The one cost is that after an interrupted change *both* passwords unlock until
//! the change is repeated successfully. That is deliberate: the alternative is a
//! state where neither password can reach a secret.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::crypto::{self, DerivedKey, EncryptedBlob};
use crate::error::{AppError, AppResult};
use crate::store_util::{config_path, load_json, save_json_atomic};

/// Plaintext of the verifier blob. Any constant works; it must never change.
const VERIFIER_PLAINTEXT: &[u8] = b"ftpie-vault-verifier-v1";
/// AAD context of the verifier blob, distinct from every secret context.
const VERIFIER_CONTEXT: &str = "ftpie:vault:verifier";
/// Current verifier file format.
const VAULT_FILE_VERSION: u8 = 1;
/// Shortest master password we will accept.
pub const MIN_MASTER_PASSWORD_LEN: usize = 8;

/// AAD context for a bookmark's stored password.
pub fn bookmark_context(bookmark_id: &str) -> String {
    format!("ftpie:bookmark:{bookmark_id}")
}

/// AAD context for an AI provider API key.
pub fn ai_key_context(provider: &str) -> String {
    format!("ftpie:ai-key:{provider}")
}

/// Reported to the frontend so it knows whether to show "set up" or "unlock".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub initialized: bool,
    pub unlocked: bool,
}

/// One generation of the vault key as it appears on disk: the Argon2id salt plus
/// [`VERIFIER_PLAINTEXT`] encrypted under the key that salt derives.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyRecord {
    /// Argon2id salt, base64.
    salt: String,
    /// Encryption of [`VERIFIER_PLAINTEXT`] under the derived key.
    verifier: EncryptedBlob,
}

/// Contents of `vault.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultFile {
    v: u8,
    /// Argon2id salt, base64.
    salt: String,
    /// Encryption of [`VERIFIER_PLAINTEXT`] under the derived key.
    verifier: EncryptedBlob,
    /// A second key that must keep working: the generation the stored secrets
    /// were under when a master-password change started. Present only while such
    /// a change is in flight, or after one was interrupted part-way. See the
    /// module docs — dropping it early is exactly what would make secrets
    /// unreadable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fallback: Option<KeyRecord>,
}

impl VaultFile {
    fn primary(&self) -> KeyRecord {
        KeyRecord {
            salt: self.salt.clone(),
            verifier: self.verifier.clone(),
        }
    }
}

/// A key that has been proven against one of the records in `vault.json`.
struct VerifiedKey {
    key: DerivedKey,
    /// The record it matched, so callers know which salt it belongs to.
    record: KeyRecord,
    /// True when it matched the retained fallback rather than the primary.
    from_fallback: bool,
}

/// The key held in memory while the vault is unlocked, together with the salt of
/// the generation it belongs to — which is not always the file's primary salt:
/// after an interrupted change, unlocking with the old password activates the
/// fallback generation.
struct ActiveKey {
    key: DerivedKey,
    salt: String,
}

/// A borrowed encrypt/decrypt handle for one generation of the vault key.
///
/// Handed to [`RekeySecrets::rekey`] so the caller can move secrets between key
/// generations without ever seeing the raw key bytes.
pub struct VaultCipher<'a> {
    key: &'a DerivedKey,
    salt: &'a str,
}

impl VaultCipher<'_> {
    pub fn encrypt(&self, plaintext: &str, context: &str) -> AppResult<EncryptedBlob> {
        crypto::encrypt_with_key(self.key, self.salt, plaintext.as_bytes(), context)
    }

    pub fn decrypt(&self, blob: &EncryptedBlob, context: &str) -> AppResult<String> {
        crypto::decrypt_string_with_key(self.key, blob, context)
    }
}

/// Implemented by every store that holds vault-encrypted secrets, so a master
/// password change can move them to the new key.
///
/// Implementations must be all-or-nothing: re-encrypt in memory, then persist
/// with a single atomic write. A partial re-key would leave unreadable secrets.
pub trait RekeySecrets {
    /// Re-encrypt every secret from `old` to `new` and persist.
    fn rekey(&mut self, old: &VaultCipher<'_>, new: &VaultCipher<'_>) -> AppResult<()>;
}

/// Nothing to re-key. Useful in tests and for a first-run vault.
pub struct NoSecrets;

impl RekeySecrets for NoSecrets {
    fn rekey(&mut self, _old: &VaultCipher<'_>, _new: &VaultCipher<'_>) -> AppResult<()> {
        Ok(())
    }
}

pub struct Vault {
    path: PathBuf,
    /// `None` until the vault has been initialized.
    file: Option<VaultFile>,
    /// Derived key, present only while unlocked. Zeroized when dropped.
    active: Option<ActiveKey>,
    /// Set when `vault.json` existed but could not be parsed. While set,
    /// `initialize` refuses to run so a recoverable vault is never replaced by a
    /// brand-new key that would orphan every stored secret.
    load_failed: bool,
    /// Test-only fault injection: `Some(n)` lets the next `n` verifier writes
    /// succeed and fails the one after, so the interrupted branches of
    /// [`Vault::change_password`] can be exercised without a real disk failure.
    #[cfg(test)]
    writes_before_failure: std::cell::Cell<Option<usize>>,
}

impl Default for Vault {
    fn default() -> Self {
        Self::load()
    }
}

impl Vault {
    /// Load the verifier from the default location. Never fails: a corrupt file
    /// is quarantined by `store_util` and the vault comes up read-only.
    pub fn load() -> Self {
        Self::load_at(config_path("vault.json"))
    }

    /// Load from an explicit path (tests, alternate profiles).
    pub fn load_at(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        match load_json::<Option<VaultFile>>(&path) {
            Ok(file) => Self {
                path,
                file,
                active: None,
                load_failed: false,
                #[cfg(test)]
                writes_before_failure: std::cell::Cell::new(None),
            },
            Err(e) => {
                tracing::error!(error = %e, "vault verifier is unreadable; vault is read-only");
                Self {
                    path,
                    file: None,
                    active: None,
                    load_failed: true,
                    #[cfg(test)]
                    writes_before_failure: std::cell::Cell::new(None),
                }
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn status(&self) -> VaultStatus {
        VaultStatus {
            initialized: self.file.is_some(),
            unlocked: self.active.is_some(),
        }
    }

    pub fn is_unlocked(&self) -> bool {
        self.active.is_some()
    }

    /// First-time setup: derive a key from `master_password`, persist a verifier
    /// blob, and leave the vault unlocked.
    ///
    /// # Blocking
    /// Runs Argon2id — call from `spawn_blocking`.
    pub fn initialize(&mut self, master_password: &str) -> AppResult<()> {
        if self.load_failed {
            return Err(AppError::config(format!(
                "{} could not be read and was moved aside; restore or delete it before creating a new vault",
                self.path.display()
            )));
        }
        if self.file.is_some() {
            return Err(AppError::config(
                "the vault is already initialized; use change_password instead".to_string(),
            ));
        }
        validate_master_password(master_password)?;

        let salt = crypto::generate_salt();
        let key = crypto::derive_key(master_password, &salt)?;
        let verifier = crypto::encrypt_with_key(&key, &salt, VERIFIER_PLAINTEXT, VERIFIER_CONTEXT)?;

        let file = VaultFile {
            v: VAULT_FILE_VERSION,
            salt: salt.clone(),
            verifier,
            fallback: None,
        };
        self.persist(&file)?;

        self.file = Some(file);
        self.active = Some(ActiveKey { key, salt });
        Ok(())
    }

    /// Verify `master_password` against the stored verifier — or, after an
    /// interrupted master-password change, against the retained fallback — and
    /// hold the derived key in memory.
    ///
    /// # Blocking
    /// Runs Argon2id — call from `spawn_blocking`.
    pub fn unlock(&mut self, master_password: &str) -> AppResult<()> {
        let verified = self.derive_and_verify(master_password)?;
        if verified.from_fallback {
            tracing::warn!(
                "unlocked with the retained previous vault key: a master password change did not \
                 finish. Change the master password again to settle on one key."
            );
        }
        self.active = Some(ActiveKey {
            key: verified.key,
            salt: verified.record.salt,
        });
        Ok(())
    }

    /// Drop the key. The `DerivedKey` destructor wipes the bytes.
    pub fn lock(&mut self) {
        self.active = None;
    }

    /// Change the master password, re-encrypting every secret `secrets` owns.
    ///
    /// See the module-level docs for the full ordering guarantees. The caller
    /// supplies the stores to re-key; the vault never reaches into them itself.
    ///
    /// # Blocking
    /// Runs Argon2id twice — call from `spawn_blocking`.
    pub fn change_password(
        &mut self,
        old: &str,
        new: &str,
        secrets: &mut dyn RekeySecrets,
    ) -> AppResult<()> {
        let current = self.derive_and_verify(old)?;
        validate_master_password(new)?;

        let new_salt = crypto::generate_salt();
        let new_key = crypto::derive_key(new, &new_salt)?;
        let new_record = KeyRecord {
            salt: new_salt.clone(),
            verifier: crypto::encrypt_with_key(
                &new_key,
                &new_salt,
                VERIFIER_PLAINTEXT,
                VERIFIER_CONTEXT,
            )?,
        };

        // Step 1: roll *forward*. The new key becomes the file's primary verifier
        // before any secret moves, and the generation the secrets are currently
        // under is retained as the fallback. Both keys are on disk from here on,
        // so no later failure can leave a secret unreachable. Nothing has moved
        // yet, so a failure here means the change simply did not happen.
        let staged = VaultFile {
            v: VAULT_FILE_VERSION,
            salt: new_record.salt.clone(),
            verifier: new_record.verifier.clone(),
            fallback: Some(current.record.clone()),
        };
        self.persist(&staged).map_err(|e| {
            AppError::config(format!(
                "could not stage the new vault verifier, master password unchanged: {e}"
            ))
        })?;
        self.file = Some(staged);

        // Step 2: move the secrets.
        let old_cipher = VaultCipher {
            key: &current.key,
            salt: &current.record.salt,
        };
        let new_cipher = VaultCipher {
            key: &new_key,
            salt: &new_salt,
        };
        if let Err(e) = secrets.rekey(&old_cipher, &new_cipher) {
            // Deliberately not rolled back. A store may have moved before the
            // failure, and un-moving it can fail too — that double fault is
            // precisely what used to strand the secrets. The retained fallback
            // means both passwords unlock, so whichever key each secret ended up
            // under is still reachable.
            return Err(AppError::config(format!(
                "the master password change could not be completed because a stored secret \
                 could not be re-encrypted: {e}. Nothing was lost — keep using the old master \
                 password. The new one also unlocks the vault until the change is repeated \
                 successfully, so whichever key a secret ended up under is still reachable."
            )));
        }

        // Step 3: commit. Every secret is under the new key, so the old
        // generation is no longer needed.
        let committed = VaultFile {
            v: VAULT_FILE_VERSION,
            salt: new_record.salt.clone(),
            verifier: new_record.verifier.clone(),
            fallback: None,
        };
        let commit = self.persist(&committed);
        self.active = Some(ActiveKey {
            key: new_key,
            salt: new_salt,
        });
        match commit {
            Ok(()) => {
                self.file = Some(committed);
                Ok(())
            }
            // The staged file is still on disk and already names the new key as
            // its primary verifier, so the new password unlocks and reads
            // everything. The only residue is the stale fallback entry.
            Err(e) => Err(AppError::config(format!(
                "the master password was changed and every secret re-encrypted, but the vault \
                 file still lists the previous key as a fallback: {e}. Nothing was lost — unlock \
                 with the new master password; changing it again drops the stale entry."
            ))),
        }
    }

    /// Encrypt a secret under the unlocked key, bound to `context` as AAD.
    ///
    /// Returns [`AppError::VaultLocked`] when locked — this is the guarantee that
    /// storing a credential can never fall back to a defaulted key.
    pub fn encrypt(&self, plaintext: &str, context: &str) -> AppResult<EncryptedBlob> {
        self.cipher()?.encrypt(plaintext, context)
    }

    /// Decrypt a secret produced by [`Vault::encrypt`] with the same `context`.
    pub fn decrypt(&self, blob: &EncryptedBlob, context: &str) -> AppResult<String> {
        self.cipher()?.decrypt(blob, context)
    }

    /// Borrow the active cipher, for callers that need to process many secrets.
    pub fn cipher(&self) -> AppResult<VaultCipher<'_>> {
        let active = self.active.as_ref().ok_or_else(AppError::vault_locked)?;
        Ok(VaultCipher {
            key: &active.key,
            salt: &active.salt,
        })
    }

    /// Write `vault.json`. The only place the verifier file is written, so the
    /// test-only fault injection has a single seam to hook.
    fn persist(&self, file: &VaultFile) -> AppResult<()> {
        #[cfg(test)]
        if let Some(remaining) = self.writes_before_failure.get() {
            if remaining == 0 {
                return Err(AppError::io(
                    "simulated failure writing the vault verifier".to_string(),
                ));
            }
            self.writes_before_failure.set(Some(remaining - 1));
        }
        save_json_atomic(&self.path, file)
    }

    /// Prove `master_password` against the primary verifier, then — only if that
    /// fails and one exists — against the retained fallback.
    ///
    /// The fallback costs a second Argon2id derivation on a wrong password, but
    /// only for a vault whose last password change was interrupted.
    fn derive_and_verify(&self, master_password: &str) -> AppResult<VerifiedKey> {
        if self.load_failed {
            return Err(AppError::config(format!(
                "{} could not be read and was moved aside; restore it to unlock the vault",
                self.path.display()
            )));
        }
        let file = self.file.as_ref().ok_or_else(|| {
            AppError::config("the vault is not initialized yet; set a master password".to_string())
        })?;
        if file.v != VAULT_FILE_VERSION {
            return Err(AppError::config(format!(
                "unsupported vault file version {} (this build understands {VAULT_FILE_VERSION})",
                file.v
            )));
        }
        if master_password.is_empty() {
            return Err(AppError::auth("a master password is required".to_string()));
        }

        let primary = file.primary();
        if let Some(key) = try_record(&primary, master_password)? {
            return Ok(VerifiedKey {
                key,
                record: primary,
                from_fallback: false,
            });
        }
        if let Some(fallback) = file.fallback.as_ref() {
            if let Some(key) = try_record(fallback, master_password)? {
                return Ok(VerifiedKey {
                    key,
                    record: fallback.clone(),
                    from_fallback: true,
                });
            }
        }
        Err(AppError::auth("incorrect master password".to_string()))
    }
}

/// Derive `password` under `record`'s salt and check it against that record's
/// verifier. `Ok(None)` is "that is not this record's password"; `Err` is a
/// derivation failure, which is not a wrong-password answer.
fn try_record(record: &KeyRecord, password: &str) -> AppResult<Option<DerivedKey>> {
    let key = crypto::derive_key(password, &record.salt)?;
    match crypto::decrypt_with_key(&key, &record.verifier, VERIFIER_CONTEXT) {
        Ok(plain) if plain == VERIFIER_PLAINTEXT => Ok(Some(key)),
        _ => Ok(None),
    }
}

fn validate_master_password(password: &str) -> AppResult<()> {
    if password.chars().count() < MIN_MASTER_PASSWORD_LEN {
        return Err(AppError::config(format!(
            "the master password must be at least {MIN_MASTER_PASSWORD_LEN} characters"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn temp_vault() -> (Vault, PathBuf) {
        let dir = std::env::temp_dir().join(format!("ftpie-vault-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("vault.json");
        (Vault::load_at(path.clone()), dir)
    }

    /// Stand-in for the bookmark store during re-key tests.
    #[derive(Default)]
    struct FakeSecrets {
        blobs: HashMap<String, EncryptedBlob>,
        fail: bool,
    }

    impl RekeySecrets for FakeSecrets {
        fn rekey(&mut self, old: &VaultCipher<'_>, new: &VaultCipher<'_>) -> AppResult<()> {
            if self.fail {
                return Err(AppError::io("disk on fire".to_string()));
            }
            let mut next = HashMap::new();
            for (id, blob) in &self.blobs {
                let ctx = bookmark_context(id);
                let plain = old.decrypt(blob, &ctx)?;
                next.insert(id.clone(), new.encrypt(&plain, &ctx)?);
            }
            self.blobs = next;
            Ok(())
        }
    }

    #[test]
    fn fresh_vault_is_uninitialized_and_locked() {
        let (vault, dir) = temp_vault();
        assert_eq!(
            vault.status(),
            VaultStatus {
                initialized: false,
                unlocked: false
            }
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn locked_vault_refuses_to_encrypt() {
        let (mut vault, dir) = temp_vault();
        vault.initialize("hunter2hunter2").unwrap();
        vault.lock();
        let err = vault.encrypt("s3cret", "ftpie:bookmark:a").unwrap_err();
        assert_eq!(err.code(), "vault_locked");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn initialize_then_unlock_roundtrips_a_secret() {
        let (mut vault, dir) = temp_vault();
        vault.initialize("hunter2hunter2").unwrap();
        let blob = vault.encrypt("s3cret", "ftpie:bookmark:a").unwrap();

        vault.lock();
        vault.unlock("hunter2hunter2").unwrap();
        assert_eq!(vault.decrypt(&blob, "ftpie:bookmark:a").unwrap(), "s3cret");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn verifier_survives_a_reload_from_disk() {
        let (mut vault, dir) = temp_vault();
        let path = vault.path().to_path_buf();
        vault.initialize("hunter2hunter2").unwrap();
        let blob = vault.encrypt("s3cret", "ctx").unwrap();
        drop(vault);

        let mut reloaded = Vault::load_at(path);
        assert!(reloaded.status().initialized);
        assert!(!reloaded.status().unlocked);
        reloaded.unlock("hunter2hunter2").unwrap();
        assert_eq!(reloaded.decrypt(&blob, "ctx").unwrap(), "s3cret");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn wrong_master_password_is_an_auth_error() {
        let (mut vault, dir) = temp_vault();
        vault.initialize("hunter2hunter2").unwrap();
        vault.lock();
        let err = vault.unlock("not-the-password").unwrap_err();
        assert_eq!(err.code(), "auth");
        assert!(!vault.is_unlocked());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn empty_and_short_master_passwords_are_refused() {
        let (mut vault, dir) = temp_vault();
        assert_eq!(vault.initialize("").unwrap_err().code(), "config");
        assert_eq!(vault.initialize("short").unwrap_err().code(), "config");
        assert!(!vault.status().initialized);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn double_initialize_is_refused() {
        let (mut vault, dir) = temp_vault();
        vault.initialize("hunter2hunter2").unwrap();
        assert_eq!(
            vault.initialize("hunter2hunter2").unwrap_err().code(),
            "config"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn change_password_rekeys_every_secret() {
        let (mut vault, dir) = temp_vault();
        vault.initialize("hunter2hunter2").unwrap();

        let mut secrets = FakeSecrets::default();
        secrets.blobs.insert(
            "a".into(),
            vault.encrypt("pw-a", &bookmark_context("a")).unwrap(),
        );
        secrets.blobs.insert(
            "b".into(),
            vault.encrypt("pw-b", &bookmark_context("b")).unwrap(),
        );

        vault
            .change_password("hunter2hunter2", "correct-horse", &mut secrets)
            .unwrap();

        // Old password no longer works, new one does, and the secrets decrypt.
        vault.lock();
        assert!(vault.unlock("hunter2hunter2").is_err());
        vault.unlock("correct-horse").unwrap();
        assert_eq!(
            vault
                .decrypt(&secrets.blobs["a"], &bookmark_context("a"))
                .unwrap(),
            "pw-a"
        );
        assert_eq!(
            vault
                .decrypt(&secrets.blobs["b"], &bookmark_context("b"))
                .unwrap(),
            "pw-b"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn failed_rekey_leaves_the_old_password_working() {
        let (mut vault, dir) = temp_vault();
        vault.initialize("hunter2hunter2").unwrap();
        let mut secrets = FakeSecrets {
            fail: true,
            ..Default::default()
        };

        assert!(vault
            .change_password("hunter2hunter2", "correct-horse", &mut secrets)
            .is_err());

        vault.lock();
        vault.unlock("hunter2hunter2").expect("old password intact");
        std::fs::remove_dir_all(dir).ok();
    }

    /// The old double fault: the verifier write failed, the rollback re-key
    /// failed too, and the new key existed nowhere on disk — so the secrets,
    /// already re-encrypted under it, were gone for good. Rolling forward makes
    /// the same interruption a non-event.
    #[test]
    fn an_interrupted_commit_still_leaves_every_secret_decryptable() {
        let (mut vault, dir) = temp_vault();
        let path = vault.path().to_path_buf();
        vault.initialize("hunter2hunter2").unwrap();

        let mut secrets = FakeSecrets::default();
        secrets.blobs.insert(
            "a".into(),
            vault.encrypt("pw-a", &bookmark_context("a")).unwrap(),
        );

        // Let the staging write through, then fail the commit. The secrets have
        // moved to the new key by then; only the file is left half-updated.
        vault.writes_before_failure.set(Some(1));
        let err = vault
            .change_password("hunter2hunter2", "correct-horse", &mut secrets)
            .unwrap_err();
        assert!(
            err.to_string()
                .contains("unlock with the new master password"),
            "the advice must describe the real recovery path: {err}"
        );

        // The running vault kept working, under the new key.
        assert_eq!(
            vault
                .decrypt(&secrets.blobs["a"], &bookmark_context("a"))
                .unwrap(),
            "pw-a"
        );
        drop(vault);

        // And so does a cold start from the half-written file: the new password
        // unlocks, because the new key was published *before* the secrets moved.
        let mut reloaded = Vault::load_at(&path);
        reloaded
            .unlock("correct-horse")
            .expect("new password works");
        assert_eq!(
            reloaded
                .decrypt(&secrets.blobs["a"], &bookmark_context("a"))
                .unwrap(),
            "pw-a"
        );

        // The old password still opens the vault too, since a failure at this
        // point cannot prove which key the secrets are under.
        let mut reloaded = Vault::load_at(&path);
        reloaded
            .unlock("hunter2hunter2")
            .expect("old password works");

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_failed_rekey_keeps_the_secrets_reachable_under_the_old_password() {
        let (mut vault, dir) = temp_vault();
        let path = vault.path().to_path_buf();
        vault.initialize("hunter2hunter2").unwrap();

        let blob = vault.encrypt("pw-a", &bookmark_context("a")).unwrap();
        let mut secrets = FakeSecrets {
            fail: true,
            ..Default::default()
        };
        secrets.blobs.insert("a".into(), blob.clone());

        let err = vault
            .change_password("hunter2hunter2", "correct-horse", &mut secrets)
            .unwrap_err();
        assert!(err.to_string().contains("old master password"), "{err}");
        drop(vault);

        // Nothing moved, and the generation the secret is under is still on disk.
        let mut reloaded = Vault::load_at(&path);
        reloaded.unlock("hunter2hunter2").unwrap();
        assert_eq!(
            reloaded.decrypt(&blob, &bookmark_context("a")).unwrap(),
            "pw-a"
        );

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_failed_staging_write_changes_nothing_at_all() {
        let (mut vault, dir) = temp_vault();
        vault.initialize("hunter2hunter2").unwrap();
        let blob = vault.encrypt("pw-a", &bookmark_context("a")).unwrap();

        let mut secrets = FakeSecrets::default();
        secrets.blobs.insert("a".into(), blob.clone());

        vault.writes_before_failure.set(Some(0));
        let err = vault
            .change_password("hunter2hunter2", "correct-horse", &mut secrets)
            .unwrap_err();
        assert!(
            err.to_string().contains("master password unchanged"),
            "{err}"
        );
        vault.writes_before_failure.set(None);

        // The secret was never touched, and the old key is still the only one.
        assert_eq!(
            secrets.blobs["a"].ciphertext, blob.ciphertext,
            "a staging failure must not have re-encrypted anything"
        );
        vault.lock();
        vault.unlock("hunter2hunter2").unwrap();
        assert!(vault.unlock("correct-horse").is_err());

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_successful_change_drops_the_fallback_key() {
        let (mut vault, dir) = temp_vault();
        let path = vault.path().to_path_buf();
        vault.initialize("hunter2hunter2").unwrap();
        let mut secrets = FakeSecrets::default();

        // Interrupt one change so a fallback is left behind...
        vault.writes_before_failure.set(Some(1));
        assert!(vault
            .change_password("hunter2hunter2", "correct-horse", &mut secrets)
            .is_err());
        vault.writes_before_failure.set(None);
        assert!(std::fs::read_to_string(&path).unwrap().contains("fallback"));

        // ...then repeat it successfully and the stale entry is gone.
        vault
            .change_password("correct-horse", "third-password", &mut secrets)
            .unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("fallback"), "{raw}");

        let mut reloaded = Vault::load_at(&path);
        assert!(reloaded.unlock("hunter2hunter2").is_err());
        assert!(reloaded.unlock("correct-horse").is_err());
        reloaded.unlock("third-password").unwrap();

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_vault_file_without_a_fallback_field_still_loads() {
        let (mut vault, dir) = temp_vault();
        let path = vault.path().to_path_buf();
        vault.initialize("hunter2hunter2").unwrap();

        // The field is absent unless an interrupted change put it there, so an
        // existing installation's file is byte-for-byte the same shape.
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("fallback"), "{raw}");

        let mut reloaded = Vault::load_at(&path);
        reloaded.unlock("hunter2hunter2").unwrap();
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn change_password_requires_the_correct_old_password() {
        let (mut vault, dir) = temp_vault();
        vault.initialize("hunter2hunter2").unwrap();
        let err = vault
            .change_password("wrong", "correct-horse", &mut NoSecrets)
            .unwrap_err();
        assert_eq!(err.code(), "auth");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn corrupt_verifier_blocks_initialize_instead_of_orphaning_secrets() {
        let dir = std::env::temp_dir().join(format!("ftpie-vault-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("vault.json");
        std::fs::write(&path, b"{ not json").unwrap();

        let mut vault = Vault::load_at(path);
        assert!(!vault.status().initialized);
        let err = vault.initialize("hunter2hunter2").unwrap_err();
        assert_eq!(err.code(), "config");
        assert!(vault.unlock("hunter2hunter2").is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn context_binding_is_enforced_through_the_vault() {
        let (mut vault, dir) = temp_vault();
        vault.initialize("hunter2hunter2").unwrap();
        let blob = vault.encrypt("pw", &bookmark_context("a")).unwrap();
        assert!(vault.decrypt(&blob, &bookmark_context("b")).is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn status_serializes_camel_case() {
        let json = serde_json::to_value(VaultStatus {
            initialized: true,
            unlocked: false,
        })
        .unwrap();
        assert_eq!(json["initialized"], true);
        assert_eq!(json["unlocked"], false);
    }
}
