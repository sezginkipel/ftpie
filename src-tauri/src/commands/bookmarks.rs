//! Bookmark commands.
//!
//! Passwords are stored only through the vault. There is no path that persists a
//! credential without an unlocked vault, and `update_bookmark` no longer accepts
//! a ciphertext blob from the frontend — a compromised or buggy renderer used to
//! be able to overwrite stored secrets with arbitrary bytes.
//!
//! Nothing here returns a [`Bookmark`]: every command answers with a
//! [`BookmarkView`], which omits `encrypted_password` and reports only the
//! derived `hasPassword` flag. Credential ciphertext, salt and nonce stay in the
//! backend, so the renderer cannot exfiltrate what it never receives.

use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::bookmarks::{Bookmark, BookmarkView, ImportReport};
use crate::error::{AppError, AppResult};
use crate::ftp::Protocol;
use crate::state::{lock_or_recover, AppState};

use super::connection::{connect, ConnectArgs, ConnectResult};

#[tauri::command]
pub async fn list_bookmarks(state: State<'_, AppState>) -> AppResult<Vec<BookmarkView>> {
    Ok(lock_or_recover(&state.bookmarks)
        .list()
        .iter()
        .map(BookmarkView::from)
        .collect())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkInput {
    pub name: String,
    pub host: String,
    pub port: Option<u16>,
    pub username: String,
    /// Plaintext. Encrypted here with the vault key and never echoed back.
    pub password: Option<String>,
    pub protocol: String,
    pub remote_path: Option<String>,
    pub local_path: Option<String>,
    pub private_key_path: Option<String>,
    pub passive_mode: Option<bool>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[tauri::command]
pub async fn create_bookmark(
    input: BookmarkInput,
    state: State<'_, AppState>,
) -> AppResult<BookmarkView> {
    let protocol = Protocol::parse(&input.protocol)?;
    let port = input.port.unwrap_or_else(|| protocol.default_port());

    let mut bookmark = Bookmark::new(
        input.name.trim(),
        input.host.trim(),
        port,
        input.username.trim(),
        protocol,
    );
    apply_input(&mut bookmark, &input);

    if let Some(password) = input.password.as_deref().filter(|p| !p.is_empty()) {
        encrypt_password(&state, &mut bookmark, password).await?;
    }

    let view = BookmarkView::from(&bookmark);
    {
        let mut store = lock_or_recover(&state.bookmarks);
        store.add(bookmark);
        store.save()?;
    }
    Ok(view)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkUpdate {
    pub id: String,
    #[serde(flatten)]
    pub fields: BookmarkInput,
    /// `true` removes the stored password. Absent or false with no `password`
    /// leaves the existing secret untouched.
    #[serde(default)]
    pub clear_password: bool,
}

/// Update in place. The old frontend deleted and recreated the bookmark, so a
/// failure between the two steps lost it permanently.
#[tauri::command]
pub async fn update_bookmark(
    update: BookmarkUpdate,
    state: State<'_, AppState>,
) -> AppResult<BookmarkView> {
    let protocol = Protocol::parse(&update.fields.protocol)?;

    let mut bookmark = {
        let store = lock_or_recover(&state.bookmarks);
        store
            .get(&update.id)
            .cloned()
            .ok_or_else(|| AppError::not_found(&update.id))?
    };

    bookmark.name = update.fields.name.trim().to_string();
    bookmark.host = update.fields.host.trim().to_string();
    bookmark.port = update
        .fields
        .port
        .unwrap_or_else(|| protocol.default_port());
    bookmark.username = update.fields.username.trim().to_string();
    bookmark.protocol = protocol;
    apply_input(&mut bookmark, &update.fields);

    if update.clear_password {
        bookmark.clear_password();
    } else if let Some(password) = update.fields.password.as_deref().filter(|p| !p.is_empty()) {
        encrypt_password(&state, &mut bookmark, password).await?;
    }

    let view = BookmarkView::from(&bookmark);
    {
        let mut store = lock_or_recover(&state.bookmarks);
        if !store.update(bookmark) {
            return Err(AppError::not_found(&update.id));
        }
        store.save()?;
    }
    Ok(view)
}

#[tauri::command]
pub async fn delete_bookmark(id: String, state: State<'_, AppState>) -> AppResult<()> {
    let mut store = lock_or_recover(&state.bookmarks);
    if !store.delete(&id) {
        return Err(AppError::not_found(&id));
    }
    store.save()
}

/// Open a session from a bookmark, decrypting the password through the vault.
#[tauri::command]
pub async fn connect_bookmark(id: String, state: State<'_, AppState>) -> AppResult<ConnectResult> {
    let bookmark = {
        let store = lock_or_recover(&state.bookmarks);
        store
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::not_found(&id))?
    };

    // Decrypting needs the vault key; Argon2 already ran at unlock time, so this
    // is cheap, but a locked vault must surface as `vault_locked` so the UI can
    // prompt and retry rather than guessing that the host was unreachable.
    let password = if bookmark.has_password() {
        let vault = Arc::clone(&state.vault);
        let bm = bookmark.clone();
        tokio::task::spawn_blocking(move || {
            let guard = lock_or_recover(&vault);
            bm.password(&guard)
        })
        .await??
    } else {
        None
    };

    let args = ConnectArgs {
        host: bookmark.host.clone(),
        port: Some(bookmark.port),
        username: bookmark.username.clone(),
        password,
        protocol: bookmark.protocol.as_str().to_string(),
        passive_mode: bookmark.passive_mode,
        private_key_path: bookmark.private_key_path.clone(),
        key_passphrase: None,
        connect_timeout_secs: None,
        io_timeout_secs: None,
    };

    connect(args, state).await
}

/// Export every bookmark encrypted with a passphrase the user supplies for the
/// archive. It is deliberately independent of the vault master password, because
/// the file is meant to travel to another machine.
#[tauri::command]
pub async fn export_bookmarks(passphrase: String, state: State<'_, AppState>) -> AppResult<String> {
    let vault = Arc::clone(&state.vault);
    let bookmarks = Arc::clone(&state.bookmarks);
    tokio::task::spawn_blocking(move || {
        let vault_guard = lock_or_recover(&vault);
        let store = lock_or_recover(&bookmarks);
        store.export_encrypted(&vault_guard, &passphrase)
    })
    .await?
}

#[tauri::command]
pub async fn import_bookmarks(
    archive: String,
    passphrase: String,
    state: State<'_, AppState>,
) -> AppResult<ImportReport> {
    let vault = Arc::clone(&state.vault);
    let bookmarks = Arc::clone(&state.bookmarks);
    tokio::task::spawn_blocking(move || {
        let vault_guard = lock_or_recover(&vault);
        let mut store = lock_or_recover(&bookmarks);
        store.import_encrypted(&archive, &passphrase, &vault_guard)
    })
    .await?
}

fn apply_input(bookmark: &mut Bookmark, input: &BookmarkInput) {
    bookmark.remote_path = input
        .remote_path
        .clone()
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| "/".to_string());
    bookmark.local_path = input.local_path.clone().filter(|p| !p.trim().is_empty());
    bookmark.private_key_path = input
        .private_key_path
        .clone()
        .filter(|p| !p.trim().is_empty());
    bookmark.passive_mode = input.passive_mode;
    bookmark.tags = input
        .tags
        .iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
}

async fn encrypt_password(
    state: &State<'_, AppState>,
    bookmark: &mut Bookmark,
    password: &str,
) -> AppResult<()> {
    let vault = Arc::clone(&state.vault);
    let mut owned = bookmark.clone();
    let password = password.to_string();

    let updated = tokio::task::spawn_blocking(move || {
        let guard = lock_or_recover(&vault);
        owned.set_password(&guard, &password)?;
        Ok::<Bookmark, AppError>(owned)
    })
    .await??;

    *bookmark = updated;
    Ok(())
}
