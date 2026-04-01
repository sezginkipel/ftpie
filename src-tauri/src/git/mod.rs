use anyhow::{Context, Result};
use git2::Repository;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatus {
    pub branch: String,
    pub ahead: usize,
    pub behind: usize,
    pub changed_files: Vec<ChangedFile>,
    pub is_dirty: bool,
    pub last_commit: Option<CommitInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitInfo {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangedFile {
    pub path: String,
    pub status: FileStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

/// Yerel git reposunun durumunu döner
pub fn get_status(repo_path: &Path) -> Result<GitStatus> {
    let repo = Repository::open(repo_path).context("git repository not found")?;

    let head = repo.head()?;
    let branch = head.shorthand().unwrap_or("HEAD").to_string();

    // Son commit bilgisi
    let last_commit = head.peel_to_commit().ok().map(|c| CommitInfo {
        hash: c.id().to_string(),
        short_hash: c.id().to_string()[..7].to_string(),
        message: c.summary().unwrap_or("").to_string(),
        author: c.author().name().unwrap_or("unknown").to_string(),
        timestamp: chrono::DateTime::from_timestamp(c.time().seconds(), 0)
            .map(|t: chrono::DateTime<chrono::Utc>| t.to_rfc3339())
            .unwrap_or_default(),
    });

    let mut changed_files = Vec::new();
    let statuses = repo.statuses(None)?;

    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let s = entry.status();

        let status = if s.is_index_new() || s.is_wt_new() {
            FileStatus::Added
        } else if s.is_index_deleted() || s.is_wt_deleted() {
            FileStatus::Deleted
        } else if s.is_index_renamed() || s.is_wt_renamed() {
            FileStatus::Renamed
        } else {
            FileStatus::Modified
        };

        changed_files.push(ChangedFile { path, status });
    }

    let is_dirty = !changed_files.is_empty();

    Ok(GitStatus {
        branch,
        ahead: 0,
        behind: 0,
        changed_files,
        is_dirty,
        last_commit,
    })
}

/// Belirtilen ref'ten bu yana değişen dosyaları döner (deploy için)
pub fn files_changed_since(repo_path: &Path, since_ref: &str) -> Result<Vec<ChangedFile>> {
    let repo = Repository::open(repo_path)?;
    let head = repo.head()?.peel_to_commit()?;
    let base = repo.revparse_single(since_ref)?.peel_to_commit()?;

    let head_tree = head.tree()?;
    let base_tree = base.tree()?;
    let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), None)?;

    let mut files = Vec::new();
    diff.foreach(
        &mut |delta, _| {
            if let Some(path) = delta.new_file().path() {
                let status = match delta.status() {
                    git2::Delta::Added => FileStatus::Added,
                    git2::Delta::Deleted => FileStatus::Deleted,
                    git2::Delta::Renamed => FileStatus::Renamed,
                    _ => FileStatus::Modified,
                };
                files.push(ChangedFile {
                    path: path.to_string_lossy().to_string(),
                    status,
                });
            }
            true
        },
        None,
        None,
        None,
    )?;

    Ok(files)
}

/// Tüm local branch'leri listeler
pub fn list_branches(repo_path: &Path) -> Result<Vec<String>> {
    let repo = Repository::open(repo_path)?;
    let branches = repo.branches(Some(git2::BranchType::Local))?;
    Ok(branches
        .filter_map(|b| {
            b.ok()
                .and_then(|(branch, _)| branch.name().ok().flatten().map(|n| n.to_string()))
        })
        .collect())
}

/// Tüm tag'leri listeler
pub fn list_tags(repo_path: &Path) -> Result<Vec<String>> {
    let repo = Repository::open(repo_path)?;
    let tags = repo.tag_names(None)?;
    Ok(tags
        .iter()
        .filter_map(|t| t.map(|s| s.to_string()))
        .collect())
}
