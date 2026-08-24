use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::ftp::RemoteFile;
use crate::state::AppState;

// ── Remote ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_remote(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<RemoteFile>> {
    let session = state.require_session(&session_id)?;
    let mut entries = session.list(&path).await?;
    sort_remote(&mut entries);
    Ok(entries)
}

#[tauri::command]
pub async fn stat_remote(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<u64> {
    let session = state.require_session(&session_id)?;
    session.size(&path).await
}

#[tauri::command]
pub async fn mkdir_remote(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let session = state.require_session(&session_id)?;
    session.mkdir_all(&path).await
}

#[tauri::command]
pub async fn rename_remote(
    session_id: String,
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let session = state.require_session(&session_id)?;
    session.rename(&from, &to).await
}

#[tauri::command]
pub async fn chmod_remote(
    session_id: String,
    path: String,
    mode: u32,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let session = state.require_session(&session_id)?;
    session.chmod(&path, mode).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRemoteArgs {
    pub session_id: String,
    pub path: String,
    #[serde(default)]
    pub is_dir: bool,
    /// Required to remove a non-empty directory; the UI must confirm first.
    #[serde(default)]
    pub recursive: bool,
}

#[tauri::command]
pub async fn delete_remote(args: DeleteRemoteArgs, state: State<'_, AppState>) -> AppResult<()> {
    let session = state.require_session(&args.session_id)?;
    if args.is_dir {
        if args.recursive {
            session.delete_dir_recursive(&args.path).await
        } else {
            session.delete_dir(&args.path).await
        }
    } else {
        session.delete_file(&args.path).await
    }
}

fn sort_remote(entries: &mut [RemoteFile]) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

// ── Local ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub is_hidden: bool,
    pub readonly: bool,
    pub modified: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalListing {
    /// Canonical form of the directory that was actually read.
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<LocalFile>,
}

#[tauri::command]
pub async fn list_local(path: Option<String>) -> AppResult<LocalListing> {
    let dir: PathBuf = match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")),
    };

    let meta = tokio::fs::metadata(&dir).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::not_found(dir.display().to_string())
        } else {
            AppError::io(format!("cannot open {}: {e}", dir.display()))
        }
    })?;
    if !meta.is_dir() {
        return Err(AppError::config(format!(
            "{} is not a directory",
            dir.display()
        )));
    }

    let mut reader = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| AppError::io(format!("cannot read {}: {e}", dir.display())))?;

    let mut entries = Vec::new();
    while let Some(entry) = reader
        .next_entry()
        .await
        .map_err(|e| AppError::io(format!("cannot walk {}: {e}", dir.display())))?
    {
        // An unreadable entry should not abort the whole listing.
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let full = entry.path();
        entries.push(LocalFile {
            is_hidden: is_hidden(&full, &name),
            name,
            path: full.to_string_lossy().to_string(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            is_dir: meta.is_dir(),
            is_symlink: meta.is_symlink(),
            readonly: meta.permissions().readonly(),
            modified: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)),
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(LocalListing {
        path: dir.to_string_lossy().to_string(),
        parent: dir
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .filter(|p| !p.is_empty()),
        entries,
    })
}

#[cfg(windows)]
fn is_hidden(path: &Path, _name: &str) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    std::fs::metadata(path)
        .map(|m| m.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_hidden(_path: &Path, name: &str) -> bool {
    name.starts_with('.')
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub path: String,
    pub label: String,
}

#[tauri::command]
pub async fn list_drives() -> AppResult<Vec<DriveInfo>> {
    let mut drives = Vec::new();

    #[cfg(windows)]
    {
        for letter in b'A'..=b'Z' {
            let root = format!("{}:\\", letter as char);
            if Path::new(&root).exists() {
                drives.push(DriveInfo {
                    label: format!("{}:", letter as char),
                    path: root,
                });
            }
        }
    }

    #[cfg(not(windows))]
    {
        drives.push(DriveInfo {
            path: "/".to_string(),
            label: "/".to_string(),
        });
    }

    // Well-known user directories are more useful than a bare drive list.
    for (label, dir) in [
        ("Home", dirs::home_dir()),
        ("Desktop", dirs::desktop_dir()),
        ("Documents", dirs::document_dir()),
        ("Downloads", dirs::download_dir()),
    ] {
        if let Some(dir) = dir {
            if dir.exists() {
                drives.push(DriveInfo {
                    label: label.to_string(),
                    path: dir.to_string_lossy().to_string(),
                });
            }
        }
    }

    Ok(drives)
}

#[tauri::command]
pub async fn mkdir_local(path: String) -> AppResult<()> {
    tokio::fs::create_dir_all(&path)
        .await
        .map_err(|e| AppError::io(format!("cannot create {path}: {e}")))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLocalArgs {
    pub path: String,
    #[serde(default)]
    pub recursive: bool,
}

#[tauri::command]
pub async fn delete_local(args: DeleteLocalArgs) -> AppResult<()> {
    let meta = tokio::fs::symlink_metadata(&args.path)
        .await
        .map_err(|e| AppError::io(format!("cannot inspect {}: {e}", args.path)))?;

    // Remove a symlink itself rather than what it points at.
    if meta.is_symlink() || !meta.is_dir() {
        return tokio::fs::remove_file(&args.path)
            .await
            .map_err(|e| AppError::io(format!("cannot delete {}: {e}", args.path)));
    }

    if args.recursive {
        tokio::fs::remove_dir_all(&args.path)
            .await
            .map_err(|e| AppError::io(format!("cannot delete {}: {e}", args.path)))
    } else {
        tokio::fs::remove_dir(&args.path)
            .await
            .map_err(|e| AppError::io(format!("cannot delete {}: {e}", args.path)))
    }
}

#[tauri::command]
pub async fn rename_local(from: String, to: String) -> AppResult<()> {
    if tokio::fs::try_exists(&to).await.unwrap_or(false) {
        return Err(AppError::config(format!("{to} already exists")));
    }
    tokio::fs::rename(&from, &to)
        .await
        .map_err(|e| AppError::io(format!("cannot rename {from} to {to}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directories_sort_before_files_case_insensitively() {
        let mut entries = vec![
            RemoteFile {
                name: "b.txt".into(),
                ..RemoteFile::dir("/", "b.txt")
            },
            RemoteFile::dir("/", "Zeta"),
            RemoteFile {
                name: "A.txt".into(),
                ..RemoteFile::dir("/", "A.txt")
            },
            RemoteFile::dir("/", "alpha"),
        ];
        // Mark the two ".txt" entries as files.
        for e in entries.iter_mut() {
            if e.name.ends_with(".txt") {
                e.is_dir = false;
            }
        }
        sort_remote(&mut entries);
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "Zeta", "A.txt", "b.txt"]);
    }

    #[cfg(not(windows))]
    #[test]
    fn dotfiles_are_hidden_on_unix() {
        assert!(is_hidden(Path::new("/tmp/.bashrc"), ".bashrc"));
        assert!(!is_hidden(Path::new("/tmp/a.txt"), "a.txt"));
    }
}
