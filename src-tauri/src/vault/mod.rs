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
//! 3. It calls [`RekeySecrets::rekey`] with an old and a new [`VaultCipher`].
//!    The implementation walks its secrets, decrypts each with the old cipher
//!    and re-encrypts with the new one under the *same* AAD context, then
//!    persists atomically (one `save_json_atomic` for the whole file).
//! 4. Only once that succeeded does the vault write the new verifier and swap
//!    its in-memory key. If the verifier write fails, the vault asks the
//!    implementation to re-key back to the old cipher so the on-disk state stays
//!    readable, and reports the failure.

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

/// Contents of `vault.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultFile {
    v: u8,
    /// Argon2id salt, base64.
    salt: String,
    /// Encryption of [`VERIFIER_PLAINTEXT`] under the derived key.
    verifier: EncryptedBlob,
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
    key: Option<DerivedKey>,
    /// Set when `vault.json` existed but could not be parsed. While set,
    /// `initialize` refuses to run so a recoverable vault is never replaced by a
    /// brand-new key that would orphan every stored secret.
    load_failed: bool,
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
                key: None,
                load_failed: false,
            },
            Err(e) => {
                tracing::error!(error = %e, "vault verifier is unreadable; vault is read-only");
                Self {
                    path,
                    file: None,
                    key: None,
                    load_failed: true,
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
            unlocked: self.key.is_some(),
        }
    }

    pub fn is_unlocked(&self) -> bool {
        self.key.is_some()
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
            salt,
            verifier,
        };
        save_json_atomic(&self.path, &file)?;

        self.file = Some(file);
        self.key = Some(key);
        Ok(())
    }

    /// Verify `master_password` against the stored verifier and hold the derived
    /// key in memory.
    ///
    /// # Blocking
    /// Runs Argon2id — call from `spawn_blocking`.
    pub fn unlock(&mut self, master_password: &str) -> AppResult<()> {
        let key = self.derive_and_verify(master_password)?;
        self.key = Some(key);
        Ok(())
    }

    /// Drop the key. The `DerivedKey` destructor wipes the bytes.
    pub fn lock(&mut self) {
        self.key = None;
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
        let old_key = self.derive_and_verify(old)?;
        let old_salt = self
            .file
            .as_ref()
            .map(|f| f.salt.clone())
            .ok_or_else(|| AppError::config("the vault is not initialized".to_string()))?;
        validate_master_password(new)?;

        let new_salt = crypto::generate_salt();
        let new_key = crypto::derive_key(new, &new_salt)?;

        let old_cipher = VaultCipher {
            key: &old_key,
            salt: &old_salt,
        };
        let new_cipher = VaultCipher {
            key: &new_key,
            salt: &new_salt,
        };

        // Step 1: move the secrets. Atomic per store; if this fails nothing has
        // changed and the old verifier still matches what is on disk.
        secrets.rekey(&old_cipher, &new_cipher)?;

        // Step 2: publish the new verifier.
        let verifier =
            crypto::encrypt_with_key(&new_key, &new_salt, VERIFIER_PLAINTEXT, VERIFIER_CONTEXT)?;
        let file = VaultFile {
            v: VAULT_FILE_VERSION,
            salt: new_salt.clone(),
            verifier,
        };
        if let Err(e) = save_json_atomic(&self.path, &file) {
            // The secrets are already under the new key but the verifier still
            // names the old one. Put the secrets back so the vault stays usable.
            match secrets.rekey(&new_cipher, &old_cipher) {
                Ok(()) => {
                    return Err(AppError::config(format!(
                        "could not write the vault verifier, master password unchanged: {e}"
                    )))
                }
                Err(rollback) => {
                    return Err(AppError::config(format!(
                        "could not write the vault verifier ({e}) and could not roll the secrets \
                         back ({rollback}); re-enter the new password to recover"
                    )))
                }
            }
        }

        self.file = Some(file);
        self.key = Some(new_key);
        Ok(())
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
        let key = self.key.as_ref().ok_or_else(AppError::vault_locked)?;
        let salt = self
            .file
            .as_ref()
            .map(|f| f.salt.as_str())
            .ok_or_else(AppError::vault_locked)?;
        Ok(VaultCipher { key, salt })
    }

    fn derive_and_verify(&self, master_password: &str) -> AppResult<DerivedKey> {
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

        let key = crypto::derive_key(master_password, &file.salt)?;
        let plain = crypto::decrypt_with_key(&key, &file.verifier, VERIFIER_CONTEXT)
            .map_err(|_| AppError::auth("incorrect master password".to_string()))?;
        if plain != VERIFIER_PLAINTEXT {
            return Err(AppError::auth("incorrect master password".to_string()));
        }
        Ok(key)
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
