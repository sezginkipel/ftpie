//! Encrypted credential storage and bookmark sync
//! AES-256-GCM encryption with Argon2 key derivation

use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use anyhow::{Context, Result};
use argon2::{Argon2, PasswordHasher};
use argon2::password_hash::SaltString;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct EncryptedBlob {
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub salt: String,
}

/// Master password'den AES-256 anahtarı türetir (Argon2id)
fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32]> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| anyhow::anyhow!("key derivation failed: {}", e))?;
    Ok(key)
}

/// Veriyi master password ile şifreler
pub fn encrypt(plaintext: &[u8], master_password: &str) -> Result<EncryptedBlob> {
    let salt = SaltString::generate(&mut OsRng);
    let key_bytes = derive_key(master_password, salt.as_str().as_bytes())?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);

    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| anyhow::anyhow!("encryption failed: {}", e))?;

    Ok(EncryptedBlob {
        ciphertext,
        nonce: nonce.to_vec(),
        salt: salt.to_string(),
    })
}

/// Şifreli veriyi çözer
pub fn decrypt(blob: &EncryptedBlob, master_password: &str) -> Result<Vec<u8>> {
    let key_bytes = derive_key(master_password, blob.salt.as_bytes())?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(&blob.nonce);

    cipher
        .decrypt(nonce, blob.ciphertext.as_ref())
        .map_err(|e| anyhow::anyhow!("decryption failed: {}", e))
}
