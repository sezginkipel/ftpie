//! Authenticated secret encryption: AES-256-GCM with an Argon2id-derived key.
//!
//! Two layers live here:
//!
//! 1. **Key derivation** — [`derive_key`] turns a password plus a salt into a
//!    32-byte [`DerivedKey`] that wipes itself on drop. Argon2id is deliberately
//!    CPU- and memory-hard, so it must never run on the async executor; call it
//!    from `tokio::task::spawn_blocking`.
//! 2. **Blob encryption** — [`encrypt_with_key`] / [`decrypt_with_key`] produce
//!    and consume [`EncryptedBlob`], a versioned, self-describing envelope whose
//!    authentication tag covers a caller-supplied *context* string as additional
//!    authenticated data (AAD).
//!
//! The AAD binding is what stops a blob from being replayed somewhere it does
//! not belong: a password encrypted under the context `"ftpie:bookmark:<id>"`
//! cannot be moved to another bookmark id, nor reused as an AI provider key,
//! because GCM verification fails when the context differs.
//!
//! The password-based convenience wrappers ([`encrypt_with_password`] /
//! [`decrypt_with_password`]) exist for data that must travel to another machine
//! (bookmark export archives), where there is no shared vault key. They are
//! *not* the path for stored credentials — those go through
//! [`crate::vault::Vault`], which never accepts an empty master password.

use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
    Aes256Gcm, Key, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::{AppError, AppResult};

/// Current envelope version. Bump only alongside a documented migration.
pub const BLOB_VERSION: u8 = 1;

/// Length of the Argon2id salt in bytes.
const SALT_LEN: usize = 16;

/// Argon2id memory cost in 1 KiB blocks (19 MiB — the OWASP baseline).
const ARGON2_M_COST: u32 = 19 * 1024;
/// Argon2id iteration count.
const ARGON2_T_COST: u32 = 2;
/// Argon2id lanes. Kept at 1 so the cost is identical on every machine.
const ARGON2_P_COST: u32 = 1;

/// Base64 alphabet used for every field of [`EncryptedBlob`].
const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

/// A versioned, context-bound secret envelope.
///
/// All three byte fields are standard base64. `v` guards the format: an unknown
/// version is rejected rather than misinterpreted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedBlob {
    pub v: u8,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

impl EncryptedBlob {
    /// Reject anything this build does not understand, with an actionable message.
    fn check_version(&self) -> AppResult<()> {
        if self.v == BLOB_VERSION {
            Ok(())
        } else {
            Err(AppError::config(format!(
                "unsupported encrypted blob version {}: this build understands version {}",
                self.v, BLOB_VERSION
            )))
        }
    }

    fn salt_bytes(&self) -> AppResult<Vec<u8>> {
        B64.decode(&self.salt)
            .map_err(|e| AppError::config(format!("encrypted blob has an invalid salt: {e}")))
    }
}

/// 32 bytes of AES-256 key material, wiped from memory when dropped.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct DerivedKey([u8; 32]);

impl DerivedKey {
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// Never print key material, not even by accident in a panic message.
impl std::fmt::Debug for DerivedKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DerivedKey(<redacted>)")
    }
}

/// Generate a fresh random salt, base64 encoded for storage.
///
/// `Aes256Gcm::generate_key` is simply 32 CSPRNG bytes from `OsRng`; taking the
/// first `SALT_LEN` of them avoids pulling in a second RNG crate.
pub fn generate_salt() -> String {
    let random = Aes256Gcm::generate_key(&mut OsRng);
    B64.encode(&random[..SALT_LEN])
}

/// Derive an AES-256 key from a password and a base64 salt using Argon2id.
///
/// # Blocking
/// This intentionally burns ~19 MiB and a few tens of milliseconds of CPU. It
/// must NOT be called from an async task directly — wrap it in
/// `tokio::task::spawn_blocking`, or the executor stalls for every other task.
pub fn derive_key(password: &str, salt_b64: &str) -> AppResult<DerivedKey> {
    if password.is_empty() {
        // Defence in depth: the vault refuses empty passwords too, but no code
        // path anywhere may derive a key from "".
        return Err(AppError::config(
            "an empty master password is not allowed".to_string(),
        ));
    }
    let salt = B64
        .decode(salt_b64)
        .map_err(|e| AppError::config(format!("invalid salt encoding: {e}")))?;
    if salt.len() < 8 {
        return Err(AppError::config(
            "salt is too short to be safe (need at least 8 bytes)".to_string(),
        ));
    }

    let params = Params::new(ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST, Some(32))
        .map_err(|e| AppError::internal(format!("invalid Argon2 parameters: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut key = [0u8; 32];
    argon
        .hash_password_into(password.as_bytes(), &salt, &mut key)
        .map_err(|e| AppError::internal(format!("key derivation failed: {e}")))?;

    let derived = DerivedKey(key);
    key.zeroize();
    Ok(derived)
}

/// Encrypt `plaintext` under an already-derived key.
///
/// `salt_b64` is copied into the blob so the envelope stays self-describing and
/// a re-key can tell which generation of key a blob belongs to. `context` is
/// authenticated but not encrypted; the exact same string is required to decrypt.
pub fn encrypt_with_key(
    key: &DerivedKey,
    salt_b64: &str,
    plaintext: &[u8],
    context: &str,
) -> AppResult<EncryptedBlob> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.as_bytes()));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);

    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad: context.as_bytes(),
            },
        )
        .map_err(|_| AppError::internal("encryption failed".to_string()))?;

    Ok(EncryptedBlob {
        v: BLOB_VERSION,
        salt: salt_b64.to_string(),
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(ciphertext),
    })
}

/// Decrypt a blob under an already-derived key.
///
/// Fails when the version is unknown, the key is wrong, the blob was tampered
/// with, or `context` does not match the context used at encryption time.
pub fn decrypt_with_key(
    key: &DerivedKey,
    blob: &EncryptedBlob,
    context: &str,
) -> AppResult<Vec<u8>> {
    blob.check_version()?;

    let nonce_bytes = B64
        .decode(&blob.nonce)
        .map_err(|e| AppError::config(format!("encrypted blob has an invalid nonce: {e}")))?;
    if nonce_bytes.len() != 12 {
        return Err(AppError::config(format!(
            "encrypted blob has a {}-byte nonce, expected 12",
            nonce_bytes.len()
        )));
    }
    let ciphertext = B64
        .decode(&blob.ciphertext)
        .map_err(|e| AppError::config(format!("encrypted blob has invalid ciphertext: {e}")))?;

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.as_bytes()));
    cipher
        .decrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: &ciphertext,
                aad: context.as_bytes(),
            },
        )
        .map_err(|_| {
            AppError::auth(
                "decryption failed: wrong password, wrong context, or tampered data".to_string(),
            )
        })
}

/// One-shot encryption with a fresh salt derived from `password`.
///
/// For portable archives (bookmark export) where the reader has no vault key.
///
/// # Blocking
/// Runs Argon2id — call from `spawn_blocking`.
pub fn encrypt_with_password(
    plaintext: &[u8],
    password: &str,
    context: &str,
) -> AppResult<EncryptedBlob> {
    let salt = generate_salt();
    let key = derive_key(password, &salt)?;
    encrypt_with_key(&key, &salt, plaintext, context)
}

/// One-shot decryption of a blob produced by [`encrypt_with_password`].
///
/// # Blocking
/// Runs Argon2id — call from `spawn_blocking`.
pub fn decrypt_with_password(
    blob: &EncryptedBlob,
    password: &str,
    context: &str,
) -> AppResult<Vec<u8>> {
    blob.check_version()?;
    // Re-encode so a hand-edited salt is normalised through the same validator.
    let salt = B64.encode(blob.salt_bytes()?);
    let key = derive_key(password, &salt)?;
    decrypt_with_key(&key, blob, context)
}

/// Decrypt a blob and require the plaintext to be valid UTF-8.
pub fn decrypt_string_with_key(
    key: &DerivedKey,
    blob: &EncryptedBlob,
    context: &str,
) -> AppResult<String> {
    let bytes = decrypt_with_key(key, blob, context)?;
    String::from_utf8(bytes)
        .map_err(|_| AppError::config("decrypted secret is not valid UTF-8".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Cheap parameters keep the test suite fast; the production path uses the
    // module constants.
    fn key_for(password: &str, salt: &str) -> DerivedKey {
        derive_key(password, salt).expect("derivation must succeed")
    }

    #[test]
    fn roundtrip_recovers_plaintext() {
        let salt = generate_salt();
        let key = key_for("correct horse battery staple", &salt);
        let blob = encrypt_with_key(&key, &salt, b"s3cret", "ftpie:bookmark:abc").unwrap();
        assert_eq!(blob.v, BLOB_VERSION);
        let plain = decrypt_with_key(&key, &blob, "ftpie:bookmark:abc").unwrap();
        assert_eq!(plain, b"s3cret");
    }

    #[test]
    fn wrong_password_fails() {
        let salt = generate_salt();
        let key = key_for("right", &salt);
        let blob = encrypt_with_key(&key, &salt, b"s3cret", "ctx").unwrap();

        let wrong = key_for("wrong", &salt);
        let err = decrypt_with_key(&wrong, &blob, "ctx").unwrap_err();
        assert_eq!(err.code(), "auth");
    }

    #[test]
    fn context_mismatch_is_rejected() {
        let salt = generate_salt();
        let key = key_for("pw", &salt);
        let blob = encrypt_with_key(&key, &salt, b"s3cret", "ftpie:bookmark:one").unwrap();

        let err = decrypt_with_key(&key, &blob, "ftpie:bookmark:two").unwrap_err();
        assert_eq!(
            err.code(),
            "auth",
            "a blob must not be replayable into another context"
        );
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let salt = generate_salt();
        let key = key_for("pw", &salt);
        let mut blob = encrypt_with_key(&key, &salt, b"s3cret", "ctx").unwrap();

        let mut raw = B64.decode(&blob.ciphertext).unwrap();
        raw[0] ^= 0xff;
        blob.ciphertext = B64.encode(raw);

        assert!(decrypt_with_key(&key, &blob, "ctx").is_err());
    }

    #[test]
    fn unknown_version_is_rejected_clearly() {
        let salt = generate_salt();
        let key = key_for("pw", &salt);
        let mut blob = encrypt_with_key(&key, &salt, b"x", "ctx").unwrap();
        blob.v = 99;

        let err = decrypt_with_key(&key, &blob, "ctx").unwrap_err();
        assert_eq!(err.code(), "config");
        assert!(err.to_string().contains("version"));
    }

    #[test]
    fn empty_password_is_refused() {
        let salt = generate_salt();
        let err = derive_key("", &salt).unwrap_err();
        assert_eq!(err.code(), "config");
    }

    #[test]
    fn password_roundtrip_for_portable_archives() {
        let blob = encrypt_with_password(b"payload", "passphrase", "ftpie:export:v1").unwrap();
        let plain = decrypt_with_password(&blob, "passphrase", "ftpie:export:v1").unwrap();
        assert_eq!(plain, b"payload");
        assert!(decrypt_with_password(&blob, "other", "ftpie:export:v1").is_err());
    }

    #[test]
    fn blob_serializes_camel_case_base64() {
        let salt = generate_salt();
        let key = key_for("pw", &salt);
        let blob = encrypt_with_key(&key, &salt, b"x", "ctx").unwrap();
        let json = serde_json::to_value(&blob).unwrap();
        assert!(json["v"].is_u64());
        assert!(
            json["ciphertext"].is_string(),
            "must be base64, not an array"
        );
        assert!(json["salt"].is_string());
    }

    #[test]
    fn nonces_never_repeat_for_the_same_key() {
        let salt = generate_salt();
        let key = key_for("pw", &salt);
        let a = encrypt_with_key(&key, &salt, b"x", "ctx").unwrap();
        let b = encrypt_with_key(&key, &salt, b"x", "ctx").unwrap();
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.ciphertext, b.ciphertext);
    }
}
