//! Credential-vault commands.
//!
//! The vault replaces the old scheme, where the frontend passed an empty string
//! as the master password and every stored server credential was therefore
//! "encrypted" with a key derived from `""`. Secrets are now unreadable without
//! a real master password, and every command that needs one fails with
//! `AppError::VaultLocked` so the UI can prompt.

use std::sync::Arc;

use tauri::State;

use crate::error::AppResult;
use crate::state::{lock_or_recover, AppState};
use crate::vault::VaultStatus;

#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> AppResult<VaultStatus> {
    Ok(lock_or_recover(&state.vault).status())
}

/// First-run setup. Argon2id is deliberately expensive, so it runs off the async
/// executor.
#[tauri::command]
pub async fn vault_initialize(
    master_password: String,
    state: State<'_, AppState>,
) -> AppResult<VaultStatus> {
    let vault = Arc::clone(&state.vault);
    tokio::task::spawn_blocking(move || {
        let mut guard = lock_or_recover(&vault);
        guard.initialize(&master_password)?;
        Ok::<VaultStatus, crate::error::AppError>(guard.status())
    })
    .await?
}

#[tauri::command]
pub async fn vault_unlock(
    master_password: String,
    state: State<'_, AppState>,
) -> AppResult<VaultStatus> {
    let vault = Arc::clone(&state.vault);
    tokio::task::spawn_blocking(move || {
        let mut guard = lock_or_recover(&vault);
        guard.unlock(&master_password)?;
        Ok::<VaultStatus, crate::error::AppError>(guard.status())
    })
    .await?
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, AppState>) -> AppResult<VaultStatus> {
    let mut guard = lock_or_recover(&state.vault);
    guard.lock();
    Ok(guard.status())
}

/// Every store that holds vault-encrypted secrets, re-keyed together.
///
/// Both must move, or the change is not complete: bookmark passwords live in
/// `bookmarks.json` and AI provider keys in `ai-keys.json`. Re-keying only the
/// bookmarks left every stored API key encrypted under a key that no longer
/// existed, which lost them silently and permanently.
struct AllSecrets<'a> {
    bookmarks: &'a mut crate::bookmarks::BookmarkStore,
    ai_keys: crate::ai::AiKeyStore,
}

impl crate::vault::RekeySecrets for AllSecrets<'_> {
    fn rekey(
        &mut self,
        old: &crate::vault::VaultCipher<'_>,
        new: &crate::vault::VaultCipher<'_>,
    ) -> AppResult<()> {
        // Bookmarks first, AI keys second. `AiKeyStore::rekey` is idempotent, so
        // if this fails part-way the vault's rollback (the same call with the
        // ciphers swapped) still resolves cleanly.
        self.bookmarks.rekey(old, new)?;
        self.ai_keys.rekey(old, new)
    }
}

/// Change the master password and re-key every stored secret in one step.
#[tauri::command]
pub async fn vault_change_password(
    old_password: String,
    new_password: String,
    state: State<'_, AppState>,
) -> AppResult<VaultStatus> {
    let vault = Arc::clone(&state.vault);
    let bookmarks = Arc::clone(&state.bookmarks);

    tokio::task::spawn_blocking(move || {
        let mut vault_guard = lock_or_recover(&vault);
        let mut bookmarks_guard = lock_or_recover(&bookmarks);
        let mut secrets = AllSecrets {
            bookmarks: &mut bookmarks_guard,
            ai_keys: crate::ai::AiKeyStore::new(),
        };
        vault_guard.change_password(&old_password, &new_password, &mut secrets)?;
        Ok::<VaultStatus, crate::error::AppError>(vault_guard.status())
    })
    .await?
}
