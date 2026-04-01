use crate::ftp::RemoteFile;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[tauri::command]
pub async fn list_remote(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<RemoteFile>, String> {
    let session_arc = state
        .get_session(&session_id)
        .ok_or_else(|| format!("session not found: {}", session_id))?;

    tokio::task::spawn_blocking(move || {
        let mut session = session_arc.lock().unwrap();
        session.list(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_local(path: String) -> Result<Vec<LocalFile>, String> {
    tokio::task::spawn_blocking(move || {
        let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
        let mut files = Vec::new();
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            files.push(LocalFile {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path().to_string_lossy().to_string(),
                size: meta.len(),
                is_dir: meta.is_dir(),
                is_symlink: meta.file_type().is_symlink(),
            });
        }
        // Klasörler önce, sonra dosyalar; alfabetik
        files.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok::<_, String>(files)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn upload(
    session_id: String,
    local_path: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let session_arc = state
        .get_session(&session_id)
        .ok_or_else(|| format!("session not found: {}", session_id))?;

    let transfer_id = uuid::Uuid::new_v4().to_string();
    let tid = transfer_id.clone();

    tokio::task::spawn_blocking(move || {
        let local = std::path::Path::new(&local_path);
        let mut session = session_arc.lock().unwrap();
        session
            .upload_local(local, &remote_path)
            .map_err(|e| e.to_string())?;
        tracing::info!(transfer_id = %tid, local = %local_path, remote = %remote_path, "upload complete");
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(transfer_id)
}

#[tauri::command]
pub async fn download(
    session_id: String,
    remote_path: String,
    local_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let session_arc = state
        .get_session(&session_id)
        .ok_or_else(|| format!("session not found: {}", session_id))?;

    let transfer_id = uuid::Uuid::new_v4().to_string();
    let tid = transfer_id.clone();

    tokio::task::spawn_blocking(move || {
        let local = std::path::Path::new(&local_path);
        let mut session = session_arc.lock().unwrap();
        session
            .download_to_local(&remote_path, local)
            .map_err(|e| e.to_string())?;
        tracing::info!(transfer_id = %tid, remote = %remote_path, local = %local_path, "download complete");
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(transfer_id)
}

#[tauri::command]
pub async fn delete_remote(
    session_id: String,
    path: String,
    is_dir: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session_arc = state
        .get_session(&session_id)
        .ok_or_else(|| format!("session not found: {}", session_id))?;

    tokio::task::spawn_blocking(move || {
        let mut session = session_arc.lock().unwrap();
        if is_dir {
            session.delete_dir(&path).map_err(|e| e.to_string())
        } else {
            session.delete_file(&path).map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rename_remote(
    session_id: String,
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session_arc = state
        .get_session(&session_id)
        .ok_or_else(|| format!("session not found: {}", session_id))?;

    tokio::task::spawn_blocking(move || {
        let mut session = session_arc.lock().unwrap();
        session.rename(&from, &to).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mkdir_remote(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session_arc = state
        .get_session(&session_id)
        .ok_or_else(|| format!("session not found: {}", session_id))?;

    tokio::task::spawn_blocking(move || {
        let mut session = session_arc.lock().unwrap();
        session.mkdir(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn chmod_remote(
    session_id: String,
    path: String,
    permissions: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session_arc = state
        .get_session(&session_id)
        .ok_or_else(|| format!("session not found: {}", session_id))?;

    tokio::task::spawn_blocking(move || {
        let mut session = session_arc.lock().unwrap();
        session.chmod(&path, permissions).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize)]
pub struct LocalFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub is_symlink: bool,
}
