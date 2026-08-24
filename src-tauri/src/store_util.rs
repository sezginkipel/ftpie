//! Durable, non-destructive JSON persistence for the on-disk stores.
//!
//! Every store (bookmarks, scripts, deploy history, trust) goes through here so
//! that a corrupt file is preserved for recovery instead of being silently
//! replaced by an empty one on the next save.

use serde::{de::DeserializeOwned, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// `%APPDATA%/ftpie` on Windows, `~/.config/ftpie` on Linux,
/// `~/Library/Application Support/ftpie` on macOS.
pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ftpie")
}

pub fn config_path(file_name: &str) -> PathBuf {
    config_dir().join(file_name)
}

/// Write JSON durably: serialize to a sibling temp file, flush and fsync it,
/// then atomically rename over the target. A failure part-way through leaves the
/// previous file intact rather than truncated.
pub fn save_json_atomic<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::config(format!("invalid store path: {}", path.display())))?;
    std::fs::create_dir_all(parent).map_err(|e| {
        AppError::io(format!(
            "cannot create config directory {}: {e}",
            parent.display()
        ))
    })?;

    let json = serde_json::to_vec_pretty(value)
        .map_err(|e| AppError::config(format!("cannot serialize store: {e}")))?;

    let tmp = path.with_extension(format!(
        "tmp-{}",
        uuid::Uuid::new_v4().simple().to_string()[..8].to_owned()
    ));

    {
        // Create with restrictive permissions from the outset. Applying them
        // after writing would leave a secret readable at the process umask
        // (commonly 0644) for the whole duration of the write.
        let mut file = create_private(&tmp)
            .map_err(|e| AppError::io(format!("cannot create temp file {}: {e}", tmp.display())))?;
        file.write_all(&json)
            .map_err(|e| AppError::io(format!("cannot write {}: {e}", tmp.display())))?;
        file.flush()
            .map_err(|e| AppError::io(format!("cannot flush {}: {e}", tmp.display())))?;
        // Durability: make sure the bytes hit the platter before the rename.
        file.sync_all()
            .map_err(|e| AppError::io(format!("cannot fsync {}: {e}", tmp.display())))?;
    }

    // std::fs::rename replaces an existing destination on both Unix and Windows.
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::io(format!(
            "cannot replace {}: {e}",
            path.display()
        )));
    }

    // Without this the rename itself can be lost on a crash, taking the
    // just-saved content with it. The previous file survives either way, so
    // nothing is corrupted — but the save would silently not have happened.
    sync_dir(parent);

    Ok(())
}

/// Open a new file for writing, owner-only where the platform expresses it.
#[cfg(unix)]
fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

/// Windows has no portable mode bits here; the file inherits the user-profile
/// ACL, which already excludes other unprivileged users.
#[cfg(not(unix))]
fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

/// fsync the containing directory so the rename is durable. Best effort: a
/// directory handle cannot be opened this way on Windows.
#[cfg(unix)]
fn sync_dir(dir: &Path) {
    if let Ok(handle) = std::fs::File::open(dir) {
        if let Err(e) = handle.sync_all() {
            tracing::debug!(dir = %dir.display(), error = %e, "cannot fsync directory");
        }
    }
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) {}

/// Load JSON from disk.
///
/// - Missing file  -> `Ok(T::default())` (a fresh install is not an error).
/// - Unreadable    -> `Err`.
/// - Unparseable   -> the bad file is moved aside as `<name>.corrupt-<ts>` and an
///   error is returned. It is never silently defaulted, because the caller would
///   then save an empty store over real user data.
pub fn load_json<T: DeserializeOwned + Default>(path: &Path) -> AppResult<T> {
    if !path.exists() {
        return Ok(T::default());
    }

    let raw = std::fs::read_to_string(path)
        .map_err(|e| AppError::io(format!("cannot read {}: {e}", path.display())))?;

    if raw.trim().is_empty() {
        return Ok(T::default());
    }

    match serde_json::from_str::<T>(&raw) {
        Ok(value) => Ok(value),
        Err(e) => {
            let backup = quarantine(path);
            Err(AppError::config(format!(
                "{} is corrupt and was moved to {}: {e}",
                path.display(),
                backup
                    .as_deref()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "<backup failed>".into())
            )))
        }
    }
}

/// Move a damaged store aside so the user can recover it by hand.
fn quarantine(path: &Path) -> Option<PathBuf> {
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let name = path.file_name()?.to_string_lossy().to_string();
    let target = path.with_file_name(format!("{name}.corrupt-{stamp}"));
    match std::fs::rename(path, &target) {
        Ok(()) => {
            tracing::error!(
                original = %path.display(),
                backup = %target.display(),
                "store file was corrupt; moved aside"
            );
            Some(target)
        }
        Err(e) => {
            tracing::error!(
                original = %path.display(),
                error = %e,
                "store file was corrupt and could not be moved aside"
            );
            None
        }
    }
}

/// Best-effort tightening of file permissions for files holding secrets.
#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        tracing::warn!(path = %path.display(), error = %e, "cannot restrict file permissions");
    }
}

/// On Windows the file inherits the user profile ACL, which already excludes
/// other unprivileged users; there is no portable chmod equivalent to apply.
#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
    struct Sample {
        items: Vec<String>,
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ftpie-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_yields_default() {
        let dir = temp_dir();
        let loaded: Sample = load_json(&dir.join("absent.json")).unwrap();
        assert_eq!(loaded, Sample::default());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn roundtrip_preserves_content() {
        let dir = temp_dir();
        let path = dir.join("store.json");
        let value = Sample {
            items: vec!["a".into(), "b".into()],
        };
        save_json_atomic(&path, &value).unwrap();
        let loaded: Sample = load_json(&path).unwrap();
        assert_eq!(loaded, value);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_file_is_quarantined_not_defaulted() {
        let dir = temp_dir();
        let path = dir.join("store.json");
        std::fs::write(&path, b"{ this is not json").unwrap();

        let result: AppResult<Sample> = load_json(&path);
        assert!(result.is_err(), "corrupt input must not silently default");

        // Original path is cleared and a .corrupt- sibling now holds the bytes.
        assert!(!path.exists());
        let siblings: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".corrupt-"))
            .collect();
        assert_eq!(siblings.len(), 1, "expected exactly one quarantined file");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_file_yields_default() {
        let dir = temp_dir();
        let path = dir.join("store.json");
        std::fs::write(&path, b"   \n").unwrap();
        let loaded: Sample = load_json(&path).unwrap();
        assert_eq!(loaded, Sample::default());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_leaves_no_temp_files_behind() {
        let dir = temp_dir();
        let path = dir.join("store.json");
        save_json_atomic(&path, &Sample::default()).unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp files leaked: {leftovers:?}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
