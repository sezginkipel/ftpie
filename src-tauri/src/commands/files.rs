use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

// Tüm dosya işlemleri SessionKind.method() üzerinden dispatch edilir.
// FTP → spawn_blocking, SFTP → doğrudan async.

#[tauri::command]
pub async fn list_remote(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<crate::ftp::RemoteFile>, String> {
    let session = state
        .get_session(&session_id)
        .ok_or_else(|| format!("oturum bulunamadı: {}", session_id))?;

    session.list(&path).await
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
    let session = state
        .get_session(&session_id)
        .ok_or_else(|| format!("oturum bulunamadı: {}", session_id))?;

    let transfer_id = uuid::Uuid::new_v4().to_string();
    let tid = transfer_id.clone();

    session
        .upload_local(std::path::PathBuf::from(&local_path), &remote_path)
        .await?;

    tracing::info!(transfer_id = %tid, local = %local_path, remote = %remote_path, "yükleme tamamlandı");
    Ok(transfer_id)
}

#[tauri::command]
pub async fn download(
    session_id: String,
    remote_path: String,
    local_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let session = state
        .get_session(&session_id)
        .ok_or_else(|| format!("oturum bulunamadı: {}", session_id))?;

    let transfer_id = uuid::Uuid::new_v4().to_string();
    let tid = transfer_id.clone();

    session
        .download_to_local(&remote_path, std::path::PathBuf::from(&local_path))
        .await?;

    tracing::info!(transfer_id = %tid, remote = %remote_path, local = %local_path, "indirme tamamlandı");
    Ok(transfer_id)
}

#[tauri::command]
pub async fn delete_remote(
    session_id: String,
    path: String,
    is_dir: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session = state
        .get_session(&session_id)
        .ok_or_else(|| format!("oturum bulunamadı: {}", session_id))?;

    if is_dir {
        session.delete_dir(&path).await
    } else {
        session.delete_file(&path).await
    }
}

#[tauri::command]
pub async fn rename_remote(
    session_id: String,
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session = state
        .get_session(&session_id)
        .ok_or_else(|| format!("oturum bulunamadı: {}", session_id))?;

    session.rename(&from, &to).await
}

#[tauri::command]
pub async fn mkdir_remote(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session = state
        .get_session(&session_id)
        .ok_or_else(|| format!("oturum bulunamadı: {}", session_id))?;

    session.mkdir(&path).await
}

#[tauri::command]
pub async fn chmod_remote(
    session_id: String,
    path: String,
    permissions: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session = state
        .get_session(&session_id)
        .ok_or_else(|| format!("oturum bulunamadı: {}", session_id))?;

    session.chmod(&path, permissions).await
}

#[derive(Debug, Serialize)]
pub struct LocalFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub is_symlink: bool,
}
