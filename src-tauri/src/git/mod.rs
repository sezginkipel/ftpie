//! Git inspection and deploy planning.
//!
//! This module is deliberately free of Tauri and of any network code: it turns a
//! repository plus a deploy request into a *plan* (an explicit upload set and an
//! explicit delete set), and the command layer executes that plan. That split is
//! what makes a dry run genuinely side-effect free and the diff logic testable.
//!
//! What changed relative to the previous implementation, and why:
//!
//! * `ahead`/`behind` were hardcoded to `0` while being serialized as if they
//!   were real. They are now computed with `Repository::graph_ahead_behind`
//!   against the branch's configured upstream, and are `None` when there is no
//!   upstream so the UI can say "no upstream" instead of lying with a zero.
//! * Excludes used `str::contains`, so excluding `log` also excluded
//!   `blog/index.html`. Patterns are now compiled into a `globset::GlobSet` with
//!   `literal_separator` enabled and gitignore-like expansion, and a malformed
//!   pattern is a hard [`AppError::Config`] instead of being silently dropped.
//! * Deploy walked the *working tree* status, so it shipped uncommitted and
//!   untracked files and was not reproducible. Deploys now resolve a committed
//!   tree; the dirty worktree is opt-in via
//!   [`DeployRequest::include_uncommitted`].
//! * Deletions and renames were filtered out, so stale files accumulated on the
//!   server forever. The plan now carries a delete set, and a rename yields both
//!   an upload of the new path and a delete of the old one.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use git2::{Delta, ObjectType, Oid, Repository, Tree};
use globset::{Glob, GlobBuilder, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

// ── Error mapping ────────────────────────────────────────────────────────────

/// Map a libgit2 error onto the app's error taxonomy. Repository/reference
/// lookups that miss become `NotFound` so the frontend can offer to pick another
/// ref instead of showing a generic failure.
fn git_err(e: git2::Error, context: &str) -> AppError {
    use git2::ErrorCode;
    match e.code() {
        ErrorCode::NotFound => AppError::NotFound {
            path: context.to_string(),
            message: format!("{context}: {}", e.message()),
        },
        ErrorCode::Auth | ErrorCode::Certificate => {
            AppError::auth(format!("{context}: {}", e.message()))
        }
        _ => AppError::config(format!("{context}: {}", e.message())),
    }
}

/// Open a repository, searching parent directories like the `git` CLI does.
pub fn open_repo(repo_path: &Path) -> AppResult<Repository> {
    Repository::discover(repo_path).map_err(|e| AppError::NotFound {
        path: repo_path.display().to_string(),
        message: format!(
            "No git repository at {} (or any parent): {}",
            repo_path.display(),
            e.message()
        ),
    })
}

// ── Status ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Branch shorthand, or `"HEAD"` when detached, or `None` on an unborn HEAD.
    pub branch: Option<String>,
    /// Full upstream ref name (e.g. `refs/remotes/origin/main`), when configured.
    pub upstream: Option<String>,
    /// Commits on the branch that the upstream does not have. `None` = no upstream.
    pub ahead: Option<usize>,
    /// Commits on the upstream that the branch does not have. `None` = no upstream.
    pub behind: Option<usize>,
    pub changed_files: Vec<ChangedFile>,
    pub is_dirty: bool,
    pub detached: bool,
    pub last_commit: Option<CommitInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    /// RFC 3339, UTC.
    pub timestamp: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub status: FileStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Typechange,
    Untracked,
}

/// Short hash without panicking on a hash shorter than 7 chars.
fn short_hash(full: &str) -> String {
    full.chars().take(7).collect()
}

fn commit_info(commit: &git2::Commit<'_>) -> CommitInfo {
    let hash = commit.id().to_string();
    CommitInfo {
        short_hash: short_hash(&hash),
        hash,
        message: commit.summary().unwrap_or("").to_string(),
        author: commit.author().name().unwrap_or("unknown").to_string(),
        timestamp: chrono::DateTime::from_timestamp(commit.time().seconds(), 0)
            .map(|t: chrono::DateTime<chrono::Utc>| t.to_rfc3339())
            .unwrap_or_default(),
    }
}

/// Working-tree status plus real ahead/behind counts.
pub fn get_status(repo_path: &Path) -> AppResult<GitStatus> {
    let repo = open_repo(repo_path)?;

    // An unborn HEAD (fresh `git init`) is a normal state, not an error.
    let head = match repo.head() {
        Ok(h) => Some(h),
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => None,
        Err(e) => return Err(git_err(e, "cannot read HEAD")),
    };

    let detached = repo.head_detached().unwrap_or(false);
    let branch = head
        .as_ref()
        .and_then(|h| h.shorthand())
        .map(|s| s.to_string());
    let last_commit = head
        .as_ref()
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| commit_info(&c));

    let (upstream, ahead, behind) = match head.as_ref() {
        Some(h) if !detached => upstream_divergence(&repo, h),
        _ => (None, None, None),
    };

    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .include_ignored(false);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| git_err(e, "cannot read working tree status"))?;

    let mut changed_files = Vec::new();
    for entry in statuses.iter() {
        let path = normalize_rel_path(entry.path().unwrap_or(""));
        if path.is_empty() {
            continue;
        }
        let s = entry.status();
        let status = if s.is_index_renamed() || s.is_wt_renamed() {
            FileStatus::Renamed
        } else if s.is_index_deleted() || s.is_wt_deleted() {
            FileStatus::Deleted
        } else if s.is_wt_new() && !s.is_index_new() {
            FileStatus::Untracked
        } else if s.is_index_new() {
            FileStatus::Added
        } else if s.is_index_typechange() || s.is_wt_typechange() {
            FileStatus::Typechange
        } else {
            FileStatus::Modified
        };
        changed_files.push(ChangedFile { path, status });
    }
    changed_files.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(GitStatus {
        branch,
        upstream,
        ahead,
        behind,
        is_dirty: !changed_files.is_empty(),
        changed_files,
        detached,
        last_commit,
    })
}

/// Resolve `(upstream_ref_name, ahead, behind)` for a branch reference.
///
/// Returns all-`None` when the branch has no configured upstream — the caller
/// must surface that as "no upstream" rather than as `0 / 0`.
fn upstream_divergence(
    repo: &Repository,
    head: &git2::Reference<'_>,
) -> (Option<String>, Option<usize>, Option<usize>) {
    let Some(refname) = head.name() else {
        return (None, None, None);
    };
    let Ok(buf) = repo.branch_upstream_name(refname) else {
        return (None, None, None);
    };
    let Some(upstream_name) = buf.as_str().map(|s| s.to_string()) else {
        return (None, None, None);
    };

    let local = match head.peel_to_commit() {
        Ok(c) => c.id(),
        Err(_) => return (Some(upstream_name), None, None),
    };
    let upstream_oid = match repo
        .find_reference(&upstream_name)
        .and_then(|r| r.peel_to_commit())
    {
        Ok(c) => c.id(),
        Err(_) => return (Some(upstream_name), None, None),
    };

    match repo.graph_ahead_behind(local, upstream_oid) {
        Ok((ahead, behind)) => (Some(upstream_name), Some(ahead), Some(behind)),
        Err(e) => {
            tracing::warn!(error = %e.message(), "graph_ahead_behind failed");
            (Some(upstream_name), None, None)
        }
    }
}

// ── Refs ─────────────────────────────────────────────────────────────────────

pub fn list_branches(repo_path: &Path) -> AppResult<Vec<String>> {
    let repo = open_repo(repo_path)?;
    let branches = repo
        .branches(Some(git2::BranchType::Local))
        .map_err(|e| git_err(e, "cannot list branches"))?;
    let mut out: Vec<String> = branches
        .filter_map(|b| {
            b.ok()
                .and_then(|(branch, _)| branch.name().ok().flatten().map(|n| n.to_string()))
        })
        .collect();
    out.sort();
    Ok(out)
}

pub fn list_tags(repo_path: &Path) -> AppResult<Vec<String>> {
    let repo = open_repo(repo_path)?;
    let tags = repo
        .tag_names(None)
        .map_err(|e| git_err(e, "cannot list tags"))?;
    let mut out: Vec<String> = tags
        .iter()
        .filter_map(|t| t.map(|s| s.to_string()))
        .collect();
    out.sort();
    Ok(out)
}

/// Resolve a branch name, tag, or commit-ish to its commit.
fn resolve_commit<'r>(repo: &'r Repository, rev: &str) -> AppResult<git2::Commit<'r>> {
    let rev = rev.trim();
    if rev.is_empty() {
        return Err(AppError::config("Empty git revision"));
    }
    repo.revparse_single(rev)
        .and_then(|obj| obj.peel_to_commit())
        .map_err(|e| git_err(e, &format!("cannot resolve revision '{rev}'")))
}

/// True when `rev` still names a reachable object — used before promising a
/// rollback that depends on a commit surviving a force-push or `gc`.
pub fn rev_exists(repo_path: &Path, rev: &str) -> bool {
    let Ok(repo) = open_repo(repo_path) else {
        return false;
    };
    // Bound to a local: a temporary in tail position outlives `repo`.
    let found = resolve_commit(&repo, rev).is_ok();
    found
}

/// Working directory of the repository containing `repo_path`.
///
/// The command layer needs this to resolve worktree-sourced uploads, because
/// `open_repo` searches upwards and the caller's path may be a subdirectory.
pub fn repo_workdir(repo_path: &Path) -> AppResult<PathBuf> {
    let repo = open_repo(repo_path)?;
    repo.workdir().map(|p| p.to_path_buf()).ok_or_else(|| {
        AppError::config("A bare repository has no working directory to deploy from")
    })
}

// ── Path helpers ─────────────────────────────────────────────────────────────

/// Normalize a repo-relative path to forward slashes with no leading slash and
/// no `.` segments. Git already stores forward slashes, but worktree-derived
/// paths on Windows can arrive with backslashes.
pub fn normalize_rel_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for segment in path.split(['/', '\\']) {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if !out.is_empty() {
            out.push('/');
        }
        out.push_str(segment);
    }
    out
}

/// Reject anything that could climb out of the remote base directory. Git tree
/// paths never contain `..`, but the plan is also fed by history records and by
/// the frontend, so this stays a hard check rather than an assumption.
fn check_safe_rel(rel: &str) -> AppResult<()> {
    if rel.is_empty() {
        return Err(AppError::config("Empty relative path in deploy plan"));
    }
    if rel.split('/').any(|s| s == "..") {
        return Err(AppError::config(format!(
            "Refusing to deploy a path that escapes the remote base: {rel}"
        )));
    }
    Ok(())
}

/// Join a remote base directory with a repo-relative path.
///
/// Handles `""`, `"."`, `"/"` and trailing-slash bases, and always emits POSIX
/// separators because that is what both FTP and SFTP speak.
pub fn join_remote(base: &str, rel: &str) -> AppResult<String> {
    check_safe_rel(rel)?;
    let rel = normalize_rel_path(rel);
    let absolute = base.starts_with('/');
    let base_norm = normalize_rel_path(base);
    Ok(match (absolute, base_norm.is_empty()) {
        (true, true) => format!("/{rel}"),
        (true, false) => format!("/{base_norm}/{rel}"),
        (false, true) => rel,
        (false, false) => format!("{base_norm}/{rel}"),
    })
}

/// Parent directory of a remote path, or `None` when it is a root-level entry.
pub fn remote_parent(path: &str) -> Option<String> {
    let idx = path.rfind('/')?;
    let parent = &path[..idx];
    if parent.is_empty() || parent == "/" {
        None
    } else {
        Some(parent.to_string())
    }
}

// ── Excludes ─────────────────────────────────────────────────────────────────

/// Compiled exclude patterns with gitignore-like semantics.
///
/// `literal_separator` is enabled, so `*` never crosses a `/`. Bare patterns are
/// expanded to match at any depth, which is what makes `*.map` work while
/// keeping `log` from matching `blog/index.html`.
#[derive(Debug, Clone)]
pub struct ExcludeSet {
    set: GlobSet,
    patterns: Vec<String>,
}

impl ExcludeSet {
    /// Compile the user's patterns. A malformed pattern is an error: silently
    /// ignoring it would deploy files the user asked to withhold.
    pub fn build(patterns: &[String]) -> AppResult<Self> {
        let mut builder = GlobSetBuilder::new();
        let mut kept = Vec::new();

        for raw in patterns {
            let pattern = raw.trim();
            // Allow comments and blank lines so a `.ftpieignore` can be passed through.
            if pattern.is_empty() || pattern.starts_with('#') {
                continue;
            }
            if pattern.starts_with('!') {
                return Err(AppError::config(format!(
                    "Negated exclude patterns are not supported: '{pattern}'"
                )));
            }
            for expanded in expand_pattern(pattern) {
                builder.add(compile_glob(&expanded, pattern)?);
            }
            kept.push(pattern.to_string());
        }

        let set = builder
            .build()
            .map_err(|e| AppError::config(format!("Invalid exclude patterns: {e}")))?;
        Ok(Self {
            set,
            patterns: kept,
        })
    }

    /// `path` must be repo-relative with forward slashes.
    pub fn is_excluded(&self, path: &str) -> bool {
        if self.set.is_empty() {
            return false;
        }
        self.set.is_match(path)
    }

    pub fn patterns(&self) -> &[String] {
        &self.patterns
    }

    pub fn is_empty(&self) -> bool {
        self.set.is_empty()
    }
}

fn compile_glob(expanded: &str, original: &str) -> AppResult<Glob> {
    GlobBuilder::new(expanded)
        // gitignore semantics: `*` stops at a path separator, `**` crosses them.
        .literal_separator(true)
        .build()
        .map_err(|e| {
            AppError::config(format!(
                "Invalid exclude pattern '{original}': {}",
                e.kind()
            ))
        })
}

/// Expand one user pattern into the globs that implement gitignore-ish matching.
fn expand_pattern(pattern: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |p: String| {
        if !p.is_empty() && !out.contains(&p) {
            out.push(p);
        }
    };

    // A trailing slash means "this directory and everything under it".
    let (body, dir_only) = match pattern.strip_suffix('/') {
        Some(stripped) => (stripped.trim_end_matches('/'), true),
        None => (pattern, false),
    };
    let body = body.trim_start_matches("./");

    if body.contains('/') {
        // Anchored (or already explicit) pattern: use it as written.
        if !dir_only {
            push(body.to_string());
        }
        if !body.ends_with("**") {
            push(format!("{body}/**"));
        }
        // `**/x/**` should also cover a root-level `x`, since globset's leading
        // `**/` does not reliably match zero components.
        if let Some(rest) = body.strip_prefix("**/") {
            if !dir_only && !rest.contains('/') {
                push(rest.to_string());
            }
            if !rest.is_empty() && !rest.ends_with("**") {
                push(format!("{rest}/**"));
            }
        }
    } else {
        // Bare name or extension pattern: match at any depth.
        if !dir_only {
            push(body.to_string());
            push(format!("**/{body}"));
        }
        push(format!("{body}/**"));
        push(format!("**/{body}/**"));
    }

    out
}

// ── Deploy plan ──────────────────────────────────────────────────────────────

/// Where an upload's bytes come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UploadSource {
    /// A blob in the resolved commit tree — reproducible.
    Tree,
    /// The working directory, only reachable with `include_uncommitted`.
    Worktree,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedUpload {
    /// Repo-relative path, forward slashes.
    pub path: String,
    pub remote_path: String,
    pub source: UploadSource,
    /// Blob hash for tree-sourced uploads; `None` for worktree files.
    pub blob_sha: Option<String>,
    /// Size in bytes as known at plan time (0 when unknown).
    pub size: u64,
    /// Why this file is in the plan.
    pub reason: FileStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedDelete {
    pub path: String,
    pub remote_path: String,
    /// `Deleted` for a removed file, `Renamed` for the old side of a rename.
    pub reason: FileStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkipReason {
    Excluded,
    /// Symlinks are not portable over FTP/SFTP deploys; the blob holds only the
    /// link target, so uploading it would silently create a bogus regular file.
    Symlink,
    Submodule,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedEntry {
    pub path: String,
    pub reason: SkipReason,
}

/// What to deploy. Constructed by the command layer from the frontend request.
#[derive(Debug, Clone)]
pub struct DeployRequest {
    /// Branch, tag, or commit-ish to deploy. Empty means `HEAD`.
    pub rev: String,
    /// Diff base. `None` deploys the full tree.
    pub base_rev: Option<String>,
    pub remote_base_path: String,
    pub exclude_patterns: Vec<String>,
    /// Opt-in to the old, non-reproducible behaviour of shipping the dirty
    /// worktree (including untracked files) on top of the resolved tree.
    pub include_uncommitted: bool,
}

impl DeployRequest {
    fn effective_rev(&self) -> &str {
        if self.rev.trim().is_empty() {
            "HEAD"
        } else {
            self.rev.trim()
        }
    }
}

/// A complete, side-effect-free description of a deploy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployPlan {
    /// The revision as requested (branch/tag/commit-ish).
    pub rev: String,
    /// Branch shorthand when `rev` resolved to one, else the requested rev.
    pub branch: String,
    pub commit_sha: String,
    pub commit: Option<CommitInfo>,
    /// Diff base, or `None` for a full-tree deploy.
    pub base_commit_sha: Option<String>,
    pub remote_base_path: String,
    pub include_uncommitted: bool,
    pub uploads: Vec<PlannedUpload>,
    pub deletes: Vec<PlannedDelete>,
    pub skipped: Vec<SkippedEntry>,
    pub total_bytes: u64,
}

impl DeployPlan {
    pub fn total_operations(&self) -> usize {
        self.uploads.len() + self.deletes.len()
    }
}

/// Build a deploy plan without touching the network or the filesystem beyond
/// reading the repository.
///
/// Resolution order:
/// 1. `rev` (default `HEAD`) is resolved with `revparse_single` and peeled to a
///    commit, so branches, tags (annotated included), and raw SHAs all work.
/// 2. If `base_rev` is given, its tree is diffed against the target tree with
///    rename detection: `Added`/`Modified`/`Copied`/`Typechange` become uploads,
///    `Deleted` becomes a delete, and `Renamed` becomes both.
/// 3. If `base_rev` is `None`, the whole target tree is walked and every blob is
///    an upload — the correct behaviour for a first deploy.
/// 4. When `include_uncommitted` is set, the target tree is additionally diffed
///    against the working directory (index blended in) and those results are
///    layered on top, marked [`UploadSource::Worktree`].
///
/// Excludes are applied to uploads *and* deletes: an excluded path is not
/// managed by the deploy at all, so it is never removed from the server either.
pub fn plan_deploy(repo_path: &Path, req: &DeployRequest) -> AppResult<DeployPlan> {
    let repo = open_repo(repo_path)?;
    let excludes = ExcludeSet::build(&req.exclude_patterns)?;
    let base_path = req.remote_base_path.clone();

    let rev = req.effective_rev().to_string();
    let commit = resolve_commit(&repo, &rev)?;
    let commit_sha = commit.id().to_string();
    let target_tree = commit
        .tree()
        .map_err(|e| git_err(e, "cannot read the target commit tree"))?;

    let branch = branch_label(&repo, &rev);

    let mut uploads: BTreeMap<String, PlannedUpload> = BTreeMap::new();
    let mut deletes: BTreeMap<String, PlannedDelete> = BTreeMap::new();
    let mut skipped: Vec<SkippedEntry> = Vec::new();

    // ── 1. tree side ─────────────────────────────────────────────────────────
    let base_commit_sha = match req.base_rev.as_deref() {
        Some(base_rev) if !base_rev.trim().is_empty() => {
            let base_commit = resolve_commit(&repo, base_rev)?;
            let base_tree = base_commit
                .tree()
                .map_err(|e| git_err(e, "cannot read the base commit tree"))?;
            diff_trees(
                &repo,
                Some(&base_tree),
                &target_tree,
                &excludes,
                &base_path,
                &mut uploads,
                &mut deletes,
                &mut skipped,
            )?;
            Some(base_commit.id().to_string())
        }
        _ => {
            walk_full_tree(
                &repo,
                &target_tree,
                &excludes,
                &base_path,
                &mut uploads,
                &mut skipped,
            )?;
            None
        }
    };

    // ── 2. optional worktree overlay ──────────────────────────────────────────
    if req.include_uncommitted {
        overlay_worktree(
            &repo,
            &target_tree,
            &excludes,
            &base_path,
            &mut uploads,
            &mut deletes,
            &mut skipped,
        )?;
    }

    // A path that is both uploaded and deleted (a rename whose old path is
    // re-created, or a worktree re-add of a file deleted in the tree) must be
    // uploaded, never deleted.
    deletes.retain(|path, _| !uploads.contains_key(path));

    let uploads: Vec<PlannedUpload> = uploads.into_values().collect();
    // Delete deepest-first so a directory's contents go before any attempt to
    // tidy the directory itself.
    let mut deletes: Vec<PlannedDelete> = deletes.into_values().collect();
    deletes.sort_by(|a, b| {
        depth(&b.path)
            .cmp(&depth(&a.path))
            .then(a.path.cmp(&b.path))
    });

    skipped.sort_by(|a, b| a.path.cmp(&b.path));
    skipped.dedup_by(|a, b| a.path == b.path);

    let total_bytes = uploads.iter().map(|u| u.size).sum();

    Ok(DeployPlan {
        rev,
        branch,
        commit: Some(commit_info(&commit)),
        commit_sha,
        base_commit_sha,
        remote_base_path: req.remote_base_path.clone(),
        include_uncommitted: req.include_uncommitted,
        uploads,
        deletes,
        skipped,
        total_bytes,
    })
}

fn depth(path: &str) -> usize {
    path.bytes().filter(|b| *b == b'/').count()
}

/// Prefer a branch shorthand for history/logging; fall back to the raw rev.
fn branch_label(repo: &Repository, rev: &str) -> String {
    if rev == "HEAD" {
        if let Ok(head) = repo.head() {
            if let Some(name) = head.shorthand() {
                return name.to_string();
            }
        }
    }
    rev.to_string()
}

/// True for a tree entry we must not push as a regular file.
fn classify_entry(entry: &git2::TreeEntry<'_>) -> Result<(), SkipReason> {
    match entry.kind() {
        Some(ObjectType::Blob) => {
            // 0o120000 — a symlink blob holds the target path, not file content.
            if entry.filemode() == 0o120000 {
                Err(SkipReason::Symlink)
            } else {
                Ok(())
            }
        }
        // A commit entry inside a tree is a submodule gitlink.
        Some(ObjectType::Commit) => Err(SkipReason::Submodule),
        _ => Err(SkipReason::Submodule),
    }
}

#[allow(clippy::too_many_arguments)]
fn walk_full_tree(
    repo: &Repository,
    tree: &Tree<'_>,
    excludes: &ExcludeSet,
    base_path: &str,
    uploads: &mut BTreeMap<String, PlannedUpload>,
    skipped: &mut Vec<SkippedEntry>,
) -> AppResult<()> {
    // `tree.walk` swallows callback errors, so collect first and validate after.
    let mut collected: Vec<(String, Oid, Option<SkipReason>)> = Vec::new();
    tree.walk(git2::TreeWalkMode::PreOrder, |root, entry| {
        if entry.kind() == Some(ObjectType::Tree) {
            return git2::TreeWalkResult::Ok;
        }
        let name = entry.name().unwrap_or("");
        if name.is_empty() {
            return git2::TreeWalkResult::Ok;
        }
        let path = normalize_rel_path(&format!("{root}{name}"));
        match classify_entry(entry) {
            Ok(()) => collected.push((path, entry.id(), None)),
            Err(reason) => collected.push((path, entry.id(), Some(reason))),
        }
        git2::TreeWalkResult::Ok
    })
    .map_err(|e| git_err(e, "cannot walk the target tree"))?;

    for (path, oid, skip) in collected {
        if excludes.is_excluded(&path) {
            skipped.push(SkippedEntry {
                path,
                reason: SkipReason::Excluded,
            });
            continue;
        }
        if let Some(reason) = skip {
            skipped.push(SkippedEntry { path, reason });
            continue;
        }
        let size = repo.find_blob(oid).map(|b| b.size() as u64).unwrap_or(0);
        let remote_path = join_remote(base_path, &path)?;
        uploads.insert(
            path.clone(),
            PlannedUpload {
                path,
                remote_path,
                source: UploadSource::Tree,
                blob_sha: Some(oid.to_string()),
                size,
                reason: FileStatus::Added,
            },
        );
    }
    Ok(())
}

/// Diff options with rename detection, shared by the tree and worktree diffs.
fn diff_options(include_untracked: bool) -> git2::DiffOptions {
    let mut opts = git2::DiffOptions::new();
    opts.include_typechange(true)
        .ignore_submodules(true)
        .include_untracked(include_untracked)
        .recurse_untracked_dirs(include_untracked);
    opts
}

#[allow(clippy::too_many_arguments)]
fn diff_trees(
    repo: &Repository,
    base: Option<&Tree<'_>>,
    target: &Tree<'_>,
    excludes: &ExcludeSet,
    base_path: &str,
    uploads: &mut BTreeMap<String, PlannedUpload>,
    deletes: &mut BTreeMap<String, PlannedDelete>,
    skipped: &mut Vec<SkippedEntry>,
) -> AppResult<()> {
    let mut opts = diff_options(false);
    let mut diff = repo
        .diff_tree_to_tree(base, Some(target), Some(&mut opts))
        .map_err(|e| git_err(e, "cannot diff the deploy trees"))?;
    let mut find = git2::DiffFindOptions::new();
    find.renames(true).copies(true);
    diff.find_similar(Some(&mut find))
        .map_err(|e| git_err(e, "rename detection failed"))?;

    apply_deltas(
        &diff,
        UploadSource::Tree,
        None,
        excludes,
        base_path,
        uploads,
        deletes,
        skipped,
    )
}

#[allow(clippy::too_many_arguments)]
fn overlay_worktree(
    repo: &Repository,
    target: &Tree<'_>,
    excludes: &ExcludeSet,
    base_path: &str,
    uploads: &mut BTreeMap<String, PlannedUpload>,
    deletes: &mut BTreeMap<String, PlannedDelete>,
    skipped: &mut Vec<SkippedEntry>,
) -> AppResult<()> {
    let mut opts = diff_options(true);
    let mut diff = repo
        .diff_tree_to_workdir_with_index(Some(target), Some(&mut opts))
        .map_err(|e| git_err(e, "cannot diff the working directory"))?;
    let mut find = git2::DiffFindOptions::new();
    find.renames(true);
    diff.find_similar(Some(&mut find))
        .map_err(|e| git_err(e, "rename detection failed"))?;

    let workdir = repo.workdir().map(|p| p.to_path_buf());
    apply_deltas(
        &diff,
        UploadSource::Worktree,
        workdir.as_deref(),
        excludes,
        base_path,
        uploads,
        deletes,
        skipped,
    )
}

/// Turn diff deltas into upload/delete entries.
///
/// `workdir` is `Some` for worktree diffs, where sizes come from the filesystem
/// because the diff reports a zero oid and a zero size for unstaged content.
#[allow(clippy::too_many_arguments)]
fn apply_deltas(
    diff: &git2::Diff<'_>,
    source: UploadSource,
    workdir: Option<&Path>,
    excludes: &ExcludeSet,
    base_path: &str,
    uploads: &mut BTreeMap<String, PlannedUpload>,
    deletes: &mut BTreeMap<String, PlannedDelete>,
    skipped: &mut Vec<SkippedEntry>,
) -> AppResult<()> {
    for delta in diff.deltas() {
        let new_path = delta
            .new_file()
            .path()
            .map(|p| normalize_rel_path(&p.to_string_lossy()));
        let old_path = delta
            .old_file()
            .path()
            .map(|p| normalize_rel_path(&p.to_string_lossy()));

        let (upload_path, delete_path, reason) = match delta.status() {
            Delta::Added | Delta::Untracked => (new_path.clone(), None, FileStatus::Added),
            Delta::Modified => (new_path.clone(), None, FileStatus::Modified),
            Delta::Copied => (new_path.clone(), None, FileStatus::Added),
            Delta::Typechange => (new_path.clone(), None, FileStatus::Typechange),
            Delta::Deleted => (None, old_path.clone(), FileStatus::Deleted),
            Delta::Renamed => (new_path.clone(), old_path.clone(), FileStatus::Renamed),
            // Unmodified / Ignored / Unreadable / Conflicted: nothing to do.
            _ => (None, None, FileStatus::Modified),
        };

        if let Some(path) = upload_path {
            if excludes.is_excluded(&path) {
                skipped.push(SkippedEntry {
                    path: path.clone(),
                    reason: SkipReason::Excluded,
                });
            } else if delta.new_file().mode() == git2::FileMode::Link {
                skipped.push(SkippedEntry {
                    path: path.clone(),
                    reason: SkipReason::Symlink,
                });
            } else {
                let size = match workdir {
                    Some(root) => std::fs::metadata(root.join(&path))
                        .map(|m| m.len())
                        .unwrap_or(0),
                    None => delta.new_file().size(),
                };
                let blob_sha = match source {
                    UploadSource::Tree => Some(delta.new_file().id().to_string()),
                    UploadSource::Worktree => None,
                };
                let remote_path = join_remote(base_path, &path)?;
                uploads.insert(
                    path.clone(),
                    PlannedUpload {
                        path,
                        remote_path,
                        source,
                        blob_sha,
                        size,
                        reason,
                    },
                );
            }
        }

        if let Some(path) = delete_path {
            if excludes.is_excluded(&path) {
                skipped.push(SkippedEntry {
                    path: path.clone(),
                    reason: SkipReason::Excluded,
                });
            } else {
                // The working tree is the newer state, so a locally deleted path
                // must not be resurrected by the committed-tree pass that ran
                // first. Without this, `includeUncommitted` on a full-tree deploy
                // would re-upload a file the user had just deleted.
                if source == UploadSource::Worktree {
                    uploads.remove(&path);
                }
                let remote_path = join_remote(base_path, &path)?;
                deletes.insert(
                    path.clone(),
                    PlannedDelete {
                        path,
                        remote_path,
                        reason,
                    },
                );
            }
        }
    }
    Ok(())
}

// ── Rollback planning ────────────────────────────────────────────────────────

/// Build the plan that restores the server to the state of one historical
/// deploy, from that deploy's commit and the exact paths it touched.
///
/// For every path the recorded deploy touched (uploaded **or** deleted):
/// * present in `commit_sha`'s tree  -> upload that committed content;
/// * absent from `commit_sha`'s tree -> delete it remotely.
///
/// See `commands::git::rollback_deploy` for the precise limits of this.
pub fn plan_rollback(
    repo_path: &Path,
    commit_sha: &str,
    remote_base_path: &str,
    paths: &[String],
    exclude_patterns: &[String],
) -> AppResult<DeployPlan> {
    let repo = open_repo(repo_path)?;
    let excludes = ExcludeSet::build(exclude_patterns)?;
    let commit = resolve_commit(&repo, commit_sha)?;
    let tree = commit
        .tree()
        .map_err(|e| git_err(e, "cannot read the rollback commit tree"))?;

    let mut uploads: BTreeMap<String, PlannedUpload> = BTreeMap::new();
    let mut deletes: BTreeMap<String, PlannedDelete> = BTreeMap::new();
    let mut skipped: Vec<SkippedEntry> = Vec::new();

    // Deduplicate while keeping a deterministic order.
    let unique: BTreeSet<String> = paths
        .iter()
        .map(|p| normalize_rel_path(p))
        .filter(|p| !p.is_empty())
        .collect();

    for path in unique {
        if excludes.is_excluded(&path) {
            skipped.push(SkippedEntry {
                path,
                reason: SkipReason::Excluded,
            });
            continue;
        }
        let remote_path = join_remote(remote_base_path, &path)?;
        match tree.get_path(&PathBuf::from(&path)) {
            Ok(entry) => {
                if let Err(reason) = classify_entry(&entry) {
                    skipped.push(SkippedEntry { path, reason });
                    continue;
                }
                let size = repo
                    .find_blob(entry.id())
                    .map(|b| b.size() as u64)
                    .unwrap_or(0);
                uploads.insert(
                    path.clone(),
                    PlannedUpload {
                        path,
                        remote_path,
                        source: UploadSource::Tree,
                        blob_sha: Some(entry.id().to_string()),
                        size,
                        reason: FileStatus::Modified,
                    },
                );
            }
            Err(_) => {
                deletes.insert(
                    path.clone(),
                    PlannedDelete {
                        path,
                        remote_path,
                        reason: FileStatus::Deleted,
                    },
                );
            }
        }
    }

    let uploads: Vec<PlannedUpload> = uploads.into_values().collect();
    let mut deletes: Vec<PlannedDelete> = deletes.into_values().collect();
    deletes.sort_by(|a, b| {
        depth(&b.path)
            .cmp(&depth(&a.path))
            .then(a.path.cmp(&b.path))
    });
    let total_bytes = uploads.iter().map(|u| u.size).sum();

    Ok(DeployPlan {
        rev: commit_sha.to_string(),
        branch: branch_label(&repo, commit_sha),
        commit: Some(commit_info(&commit)),
        commit_sha: commit.id().to_string(),
        base_commit_sha: None,
        remote_base_path: remote_base_path.to_string(),
        include_uncommitted: false,
        uploads,
        deletes,
        skipped,
        total_bytes,
    })
}

// ── Blob materialisation ─────────────────────────────────────────────────────

/// Write one blob to `dest`, creating parents. Returns the byte count.
///
/// libgit2 always inflates a blob fully into memory, so there is no streaming to
/// be had on this side; staging to a file at least keeps the *network* side
/// streaming through `upload_local`, and only one blob is resident at a time.
pub fn write_blob_to(repo: &Repository, blob_sha: &str, dest: &Path) -> AppResult<u64> {
    let oid = Oid::from_str(blob_sha)
        .map_err(|e| AppError::config(format!("invalid blob id '{blob_sha}': {}", e.message())))?;
    let blob = repo
        .find_blob(oid)
        .map_err(|e| git_err(e, &format!("cannot read blob {blob_sha}")))?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::io(format!(
                "cannot create staging directory {}: {e}",
                parent.display()
            ))
        })?;
    }
    let content = blob.content();
    std::fs::write(dest, content)
        .map_err(|e| AppError::io(format!("cannot stage {}: {e}", dest.display())))?;
    Ok(content.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── path helpers ─────────────────────────────────────────────────────────

    #[test]
    fn normalizes_separators_and_dot_segments() {
        assert_eq!(normalize_rel_path("src\\app\\main.rs"), "src/app/main.rs");
        assert_eq!(normalize_rel_path("./dist/index.html"), "dist/index.html");
        assert_eq!(normalize_rel_path("/leading/slash"), "leading/slash");
        assert_eq!(normalize_rel_path("a//b///c"), "a/b/c");
        assert_eq!(normalize_rel_path(""), "");
    }

    #[test]
    fn joins_remote_paths_without_double_slashes() {
        assert_eq!(
            join_remote("/var/www", "a/b.txt").unwrap(),
            "/var/www/a/b.txt"
        );
        assert_eq!(join_remote("/var/www/", "a.txt").unwrap(), "/var/www/a.txt");
        assert_eq!(join_remote("/", "a.txt").unwrap(), "/a.txt");
        assert_eq!(join_remote("", "a.txt").unwrap(), "a.txt");
        assert_eq!(
            join_remote("public_html", "a.txt").unwrap(),
            "public_html/a.txt"
        );
        // Windows-style base and rel both normalise to POSIX.
        assert_eq!(
            join_remote("/var\\www", "a\\b.txt").unwrap(),
            "/var/www/a/b.txt"
        );
    }

    #[test]
    fn rejects_paths_that_escape_the_remote_base() {
        assert_eq!(
            join_remote("/var/www", "../etc/passwd").unwrap_err().code(),
            "config"
        );
        assert_eq!(
            join_remote("/var/www", "a/../../b").unwrap_err().code(),
            "config"
        );
        assert_eq!(join_remote("/var/www", "").unwrap_err().code(), "config");
    }

    #[test]
    fn remote_parent_is_none_at_the_root() {
        assert_eq!(remote_parent("/var/www/a.txt").as_deref(), Some("/var/www"));
        assert_eq!(remote_parent("a/b/c.txt").as_deref(), Some("a/b"));
        assert_eq!(remote_parent("/a.txt"), None);
        assert_eq!(remote_parent("a.txt"), None);
    }

    // ── excludes ─────────────────────────────────────────────────────────────

    #[test]
    fn bare_pattern_does_not_match_a_substring_of_a_directory() {
        // The regression this whole ExcludeSet exists for: `str::contains("log")`
        // excluded `blog/index.html`.
        let ex = ExcludeSet::build(&["log".to_string()]).unwrap();
        assert!(!ex.is_excluded("blog/index.html"));
        assert!(!ex.is_excluded("weblog.txt"));
        assert!(!ex.is_excluded("a/catalog/x"));
        assert!(ex.is_excluded("log"));
        assert!(ex.is_excluded("log/app.txt"));
        assert!(ex.is_excluded("var/log/app.txt"));
        assert!(ex.is_excluded("var/log"));
    }

    #[test]
    fn extension_patterns_match_at_any_depth() {
        let ex = ExcludeSet::build(&["*.map".to_string()]).unwrap();
        assert!(ex.is_excluded("app.map"));
        assert!(ex.is_excluded("dist/js/app.min.map"));
        assert!(!ex.is_excluded("app.mapx"));
        assert!(!ex.is_excluded("map"));
    }

    #[test]
    fn directory_patterns_cover_their_contents() {
        let ex = ExcludeSet::build(&["dist/**".to_string()]).unwrap();
        assert!(ex.is_excluded("dist/index.html"));
        assert!(ex.is_excluded("dist/a/b/c.js"));
        assert!(!ex.is_excluded("distribution/index.html"));
        assert!(!ex.is_excluded("src/dist/x.js"), "dist/** is anchored");

        let ex = ExcludeSet::build(&["node_modules/".to_string()]).unwrap();
        assert!(ex.is_excluded("node_modules/left-pad/index.js"));
        assert!(ex.is_excluded("packages/a/node_modules/x.js"));
        assert!(!ex.is_excluded("node_modules_backup/x.js"));
    }

    #[test]
    fn globstar_patterns_match_at_the_root_too() {
        let ex = ExcludeSet::build(&["**/node_modules/**".to_string()]).unwrap();
        assert!(ex.is_excluded("node_modules/a.js"));
        assert!(ex.is_excluded("a/b/node_modules/c.js"));
        assert!(!ex.is_excluded("src/index.js"));
    }

    #[test]
    fn star_does_not_cross_a_separator() {
        let ex = ExcludeSet::build(&["dist/*.js".to_string()]).unwrap();
        assert!(ex.is_excluded("dist/app.js"));
        assert!(!ex.is_excluded("dist/vendor/app.js"));
    }

    #[test]
    fn comments_and_blank_patterns_are_ignored() {
        let ex = ExcludeSet::build(&[
            "  ".to_string(),
            "# a comment".to_string(),
            "*.log".to_string(),
        ])
        .unwrap();
        assert_eq!(ex.patterns(), ["*.log"]);
        assert!(ex.is_excluded("a/b.log"));
    }

    #[test]
    fn invalid_patterns_are_reported_not_ignored() {
        let err = ExcludeSet::build(&["[".to_string()]).unwrap_err();
        assert_eq!(err.code(), "config");
        let err = ExcludeSet::build(&["!keep.txt".to_string()]).unwrap_err();
        assert_eq!(err.code(), "config");
    }

    #[test]
    fn empty_exclude_set_excludes_nothing() {
        let ex = ExcludeSet::build(&[]).unwrap();
        assert!(ex.is_empty());
        assert!(!ex.is_excluded("anything/at/all"));
    }

    // ── scratch repository fixtures ──────────────────────────────────────────

    struct Scratch {
        dir: PathBuf,
        repo: Repository,
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("ftpie-git-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let repo = Repository::init(&dir).unwrap();
            Self { dir, repo }
        }

        fn write(&self, rel: &str, content: &str) {
            let path = self.dir.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }

        fn remove(&self, rel: &str) {
            std::fs::remove_file(self.dir.join(rel)).unwrap();
        }

        /// Stage everything currently in the workdir and commit it.
        fn commit_all(&self, message: &str) -> Oid {
            let mut index = self.repo.index().unwrap();
            index
                .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
                .unwrap();
            // add_all does not stage deletions of tracked files.
            index.update_all(["*"].iter(), None).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = self.repo.find_tree(tree_id).unwrap();
            let sig = git2::Signature::now("Test", "test@example.com").unwrap();
            let parent = self.repo.head().ok().and_then(|h| h.peel_to_commit().ok());
            let parents: Vec<&git2::Commit<'_>> = parent.iter().collect();
            self.repo
                .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
                .unwrap()
        }

        fn plan(&self, base: Option<&str>, excludes: &[&str], dirty: bool) -> DeployPlan {
            plan_deploy(
                &self.dir,
                &DeployRequest {
                    rev: "HEAD".into(),
                    base_rev: base.map(|s| s.to_string()),
                    remote_base_path: "/var/www".into(),
                    exclude_patterns: excludes.iter().map(|s| s.to_string()).collect(),
                    include_uncommitted: dirty,
                },
            )
            .unwrap()
        }
    }

    fn upload_paths(plan: &DeployPlan) -> Vec<&str> {
        plan.uploads.iter().map(|u| u.path.as_str()).collect()
    }

    fn delete_paths(plan: &DeployPlan) -> Vec<&str> {
        plan.deletes.iter().map(|d| d.path.as_str()).collect()
    }

    // ── plan construction ────────────────────────────────────────────────────

    #[test]
    fn no_base_plans_the_whole_tree() {
        let s = Scratch::new();
        s.write("index.html", "hello");
        s.write("assets/app.js", "console.log(1)");
        s.commit_all("initial");

        let plan = s.plan(None, &[], false);
        assert_eq!(upload_paths(&plan), ["assets/app.js", "index.html"]);
        assert!(plan.deletes.is_empty());
        assert!(plan.base_commit_sha.is_none());
        assert_eq!(
            plan.uploads[1].remote_path, "/var/www/index.html",
            "remote paths are joined onto the base"
        );
        assert!(plan.uploads.iter().all(|u| u.source == UploadSource::Tree));
        assert_eq!(plan.total_bytes, 5 + 14);
    }

    #[test]
    fn diff_against_a_base_produces_uploads_and_deletes() {
        let s = Scratch::new();
        s.write("keep.txt", "keep");
        s.write("gone.txt", "gone");
        s.write("changed.txt", "v1");
        let first = s.commit_all("first");

        s.remove("gone.txt");
        s.write("changed.txt", "v2");
        s.write("new.txt", "new");
        s.commit_all("second");

        let plan = s.plan(Some(&first.to_string()), &[], false);
        assert_eq!(upload_paths(&plan), ["changed.txt", "new.txt"]);
        assert_eq!(delete_paths(&plan), ["gone.txt"]);
        assert_eq!(plan.base_commit_sha.as_deref(), Some(&*first.to_string()));
        assert_eq!(plan.total_operations(), 3);
        assert!(
            !upload_paths(&plan).contains(&"keep.txt"),
            "an unchanged file must not be re-uploaded"
        );
    }

    #[test]
    fn a_rename_uploads_the_new_path_and_deletes_the_old_one() {
        let s = Scratch::new();
        // Rename detection needs enough content to score a similarity match.
        let body = "the quick brown fox jumps over the lazy dog\n".repeat(20);
        s.write("old/name.txt", &body);
        let first = s.commit_all("first");

        s.remove("old/name.txt");
        s.write("new/name.txt", &body);
        s.commit_all("rename");

        let plan = s.plan(Some(&first.to_string()), &[], false);
        assert_eq!(upload_paths(&plan), ["new/name.txt"]);
        assert_eq!(
            delete_paths(&plan),
            ["old/name.txt"],
            "the stale remote path must be removed"
        );
        assert_eq!(plan.uploads[0].reason, FileStatus::Renamed);
        assert_eq!(plan.deletes[0].remote_path, "/var/www/old/name.txt");
    }

    #[test]
    fn excludes_suppress_uploads_and_deletes_alike() {
        let s = Scratch::new();
        s.write("app.js", "a");
        s.write("app.js.map", "m");
        s.write("logs/old.txt", "x");
        let first = s.commit_all("first");

        s.remove("logs/old.txt");
        s.remove("app.js.map");
        s.write("app.js", "b");
        s.commit_all("second");

        let plan = s.plan(Some(&first.to_string()), &["*.map", "logs/"], false);
        assert_eq!(upload_paths(&plan), ["app.js"]);
        assert!(
            plan.deletes.is_empty(),
            "an excluded path is unmanaged, so it is never deleted remotely"
        );
        assert!(plan
            .skipped
            .iter()
            .any(|s| s.path == "app.js.map" && s.reason == SkipReason::Excluded));
    }

    #[test]
    fn committed_tree_is_the_default_and_ignores_the_dirty_worktree() {
        let s = Scratch::new();
        s.write("index.html", "committed");
        s.commit_all("first");
        s.write("index.html", "dirty edit");
        s.write("scratch.tmp", "untracked");

        let clean = s.plan(None, &[], false);
        assert_eq!(
            upload_paths(&clean),
            ["index.html"],
            "untracked files must not leak into a reproducible deploy"
        );
        assert_eq!(clean.uploads[0].size, "committed".len() as u64);

        let dirty = s.plan(None, &[], true);
        assert_eq!(upload_paths(&dirty), ["index.html", "scratch.tmp"]);
        let idx = dirty
            .uploads
            .iter()
            .position(|u| u.path == "index.html")
            .unwrap();
        assert_eq!(dirty.uploads[idx].source, UploadSource::Worktree);
        assert_eq!(dirty.uploads[idx].size, "dirty edit".len() as u64);
        assert!(dirty.uploads[idx].blob_sha.is_none());
    }

    #[test]
    fn worktree_overlay_reports_local_deletions() {
        let s = Scratch::new();
        s.write("a.txt", "a");
        s.write("b.txt", "b");
        s.commit_all("first");
        s.remove("b.txt");

        let plan = s.plan(None, &[], true);
        assert_eq!(upload_paths(&plan), ["a.txt"]);
        assert_eq!(delete_paths(&plan), ["b.txt"]);
    }

    #[test]
    fn a_locally_deleted_file_is_not_resurrected_by_the_tree_pass() {
        let s = Scratch::new();
        s.write("stays.txt", "1");
        s.write("removed.txt", "2");
        s.commit_all("first");
        s.remove("removed.txt");

        // The full-tree pass sees removed.txt as an upload; the worktree overlay
        // must override it with a delete, not ship the committed copy back.
        let plan = s.plan(None, &[], true);
        assert_eq!(upload_paths(&plan), ["stays.txt"]);
        assert_eq!(delete_paths(&plan), ["removed.txt"]);
    }

    #[test]
    fn deletes_are_ordered_deepest_first() {
        let s = Scratch::new();
        s.write("a/b/c/deep.txt", "1");
        s.write("a/shallow.txt", "2");
        s.write("root.txt", "3");
        let first = s.commit_all("first");
        s.remove("a/b/c/deep.txt");
        s.remove("a/shallow.txt");
        s.remove("root.txt");
        s.write("placeholder.txt", "keep the tree non-empty");
        s.commit_all("second");

        let plan = s.plan(Some(&first.to_string()), &[], false);
        assert_eq!(
            delete_paths(&plan),
            ["a/b/c/deep.txt", "a/shallow.txt", "root.txt"]
        );
    }

    #[test]
    fn an_upload_always_wins_over_a_delete_for_the_same_path() {
        let s = Scratch::new();
        let body = "shared content line\n".repeat(30);
        s.write("moved.txt", &body);
        let first = s.commit_all("first");

        // Rename away, then re-create the original path with new content: the
        // rename's delete of `moved.txt` must not clobber the fresh upload.
        s.remove("moved.txt");
        s.write("elsewhere.txt", &body);
        s.write(
            "moved.txt",
            "brand new content that is quite different indeed",
        );
        s.commit_all("second");

        let plan = s.plan(Some(&first.to_string()), &[], false);
        assert!(upload_paths(&plan).contains(&"moved.txt"));
        assert!(
            !delete_paths(&plan).contains(&"moved.txt"),
            "a path being uploaded must never also be deleted"
        );
    }

    #[test]
    fn symlinks_and_submodules_are_skipped_not_uploaded() {
        // Symlink creation needs privileges on Windows, so build the tree object
        // directly instead of touching the filesystem.
        let s = Scratch::new();
        s.write("real.txt", "content");
        s.commit_all("first");

        let blob = s.repo.blob(b"real.txt").unwrap();
        let mut builder = s.repo.treebuilder(None).unwrap();
        builder.insert("link", blob, 0o120000).unwrap();
        builder
            .insert("real.txt", s.repo.blob(b"content").unwrap(), 0o100644)
            .unwrap();
        let tree_id = builder.write().unwrap();
        let tree = s.repo.find_tree(tree_id).unwrap();
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        let parent = s.repo.head().unwrap().peel_to_commit().unwrap();
        s.repo
            .commit(
                Some("HEAD"),
                &sig,
                &sig,
                "with a symlink",
                &tree,
                &[&parent],
            )
            .unwrap();

        let plan = s.plan(None, &[], false);
        assert_eq!(upload_paths(&plan), ["real.txt"]);
        assert!(plan
            .skipped
            .iter()
            .any(|e| e.path == "link" && e.reason == SkipReason::Symlink));
    }

    #[test]
    fn tags_and_raw_shas_resolve_as_deploy_targets() {
        let s = Scratch::new();
        s.write("a.txt", "a");
        let first = s.commit_all("first");
        s.repo
            .tag_lightweight("v1", &s.repo.find_object(first, None).unwrap(), false)
            .unwrap();
        s.write("b.txt", "b");
        s.commit_all("second");

        for rev in ["v1", &first.to_string()[..8]] {
            let plan = plan_deploy(
                &s.dir,
                &DeployRequest {
                    rev: rev.to_string(),
                    base_rev: None,
                    remote_base_path: "/w".into(),
                    exclude_patterns: vec![],
                    include_uncommitted: false,
                },
            )
            .unwrap();
            assert_eq!(upload_paths(&plan), ["a.txt"], "rev {rev}");
            assert_eq!(plan.commit_sha, first.to_string());
        }
    }

    #[test]
    fn an_unknown_revision_is_a_not_found_error() {
        let s = Scratch::new();
        s.write("a.txt", "a");
        s.commit_all("first");
        let err = plan_deploy(
            &s.dir,
            &DeployRequest {
                rev: "no-such-branch".into(),
                base_rev: None,
                remote_base_path: "/w".into(),
                exclude_patterns: vec![],
                include_uncommitted: false,
            },
        )
        .unwrap_err();
        assert_eq!(err.code(), "not_found");
    }

    // ── status ───────────────────────────────────────────────────────────────

    #[test]
    fn status_reports_no_upstream_as_none_not_zero() {
        let s = Scratch::new();
        s.write("a.txt", "a");
        s.commit_all("first");

        let status = get_status(&s.dir).unwrap();
        assert!(status.upstream.is_none());
        assert!(
            status.ahead.is_none() && status.behind.is_none(),
            "a branch with no upstream must not claim 0/0"
        );
        assert_eq!(status.branch.as_deref(), Some("master").or(Some("main")));
        assert!(!status.is_dirty);
        assert_eq!(status.last_commit.unwrap().message, "first");
    }

    #[test]
    fn status_computes_real_ahead_behind_against_an_upstream() {
        let s = Scratch::new();
        s.write("a.txt", "a");
        let base = s.commit_all("first");

        // Fake an upstream exactly as `git remote add` + `git push -u` would: a
        // configured remote, a remote-tracking ref, and the branch's upstream
        // config. Nothing here touches the network.
        let head_name = s.repo.head().unwrap().name().unwrap().to_string();
        let branch_short = head_name.rsplit('/').next().unwrap().to_string();
        s.repo
            .remote("origin", "https://example.invalid/repo.git")
            .unwrap();
        s.repo
            .reference(
                &format!("refs/remotes/origin/{branch_short}"),
                base,
                true,
                "test upstream",
            )
            .unwrap();
        let mut branch = s
            .repo
            .find_branch(&branch_short, git2::BranchType::Local)
            .unwrap();
        branch
            .set_upstream(Some(&format!("origin/{branch_short}")))
            .unwrap();
        drop(branch);

        let status = get_status(&s.dir).unwrap();
        assert_eq!(status.ahead, Some(0));
        assert_eq!(status.behind, Some(0));
        assert!(status.upstream.unwrap().contains("origin"));

        // Two local commits the upstream does not have.
        s.write("b.txt", "b");
        s.commit_all("second");
        s.write("c.txt", "c");
        s.commit_all("third");

        let status = get_status(&s.dir).unwrap();
        assert_eq!(status.ahead, Some(2));
        assert_eq!(status.behind, Some(0));
    }

    #[test]
    fn status_lists_dirty_and_untracked_files() {
        let s = Scratch::new();
        s.write("tracked.txt", "v1");
        s.commit_all("first");
        s.write("tracked.txt", "v2");
        s.write("fresh.txt", "new");

        let status = get_status(&s.dir).unwrap();
        assert!(status.is_dirty);
        let paths: Vec<&str> = status
            .changed_files
            .iter()
            .map(|f| f.path.as_str())
            .collect();
        assert_eq!(paths, ["fresh.txt", "tracked.txt"]);
        assert_eq!(status.changed_files[0].status, FileStatus::Untracked);
        assert_eq!(status.changed_files[1].status, FileStatus::Modified);
    }

    #[test]
    fn branches_and_tags_are_listed_sorted() {
        let s = Scratch::new();
        s.write("a.txt", "a");
        let first = s.commit_all("first");
        let obj = s.repo.find_object(first, None).unwrap();
        s.repo.tag_lightweight("v2", &obj, false).unwrap();
        s.repo.tag_lightweight("v1", &obj, false).unwrap();
        s.repo
            .branch("feature", &s.repo.find_commit(first).unwrap(), false)
            .unwrap();

        assert_eq!(list_tags(&s.dir).unwrap(), ["v1", "v2"]);
        assert!(list_branches(&s.dir)
            .unwrap()
            .contains(&"feature".to_string()));
    }

    #[test]
    fn a_missing_repository_is_a_not_found_error() {
        let dir = std::env::temp_dir().join(format!("ftpie-norepo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let err = get_status(&dir).unwrap_err();
        assert_eq!(err.code(), "not_found");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── rollback planning ────────────────────────────────────────────────────

    #[test]
    fn rollback_uploads_paths_present_at_the_commit_and_deletes_the_rest() {
        let s = Scratch::new();
        s.write("a.txt", "old-a");
        s.write("b.txt", "old-b");
        let first = s.commit_all("first");

        s.write("a.txt", "new-a");
        s.remove("b.txt");
        s.write("c.txt", "new-c");
        s.commit_all("second");

        // Replay the first deploy: a.txt and b.txt existed then, c.txt did not.
        let plan = plan_rollback(
            &s.dir,
            &first.to_string(),
            "/var/www",
            &[
                "a.txt".to_string(),
                "b.txt".to_string(),
                "c.txt".to_string(),
            ],
            &[],
        )
        .unwrap();

        assert_eq!(upload_paths(&plan), ["a.txt", "b.txt"]);
        assert_eq!(delete_paths(&plan), ["c.txt"]);
        assert_eq!(plan.uploads[0].size, "old-a".len() as u64);
        assert_eq!(plan.uploads[0].remote_path, "/var/www/a.txt");
    }

    #[test]
    fn rollback_to_a_pruned_commit_fails_loudly() {
        let s = Scratch::new();
        s.write("a.txt", "a");
        s.commit_all("first");
        let err = plan_rollback(
            &s.dir,
            "0123456789abcdef0123456789abcdef01234567",
            "/w",
            &["a.txt".to_string()],
            &[],
        )
        .unwrap_err();
        assert_eq!(err.code(), "not_found");
        assert!(!rev_exists(
            &s.dir,
            "0123456789abcdef0123456789abcdef01234567"
        ));
    }

    #[test]
    fn blobs_are_staged_byte_for_byte() {
        let s = Scratch::new();
        s.write("a.txt", "exact bytes");
        s.commit_all("first");

        let plan = s.plan(None, &[], false);
        let sha = plan.uploads[0].blob_sha.clone().unwrap();
        let dest = s.dir.join("staging").join("nested").join("a.txt");
        let n = write_blob_to(&s.repo, &sha, &dest).unwrap();
        assert_eq!(n, 11);
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "exact bytes");
    }

    #[test]
    fn plan_serializes_camel_case() {
        let s = Scratch::new();
        s.write("a.txt", "a");
        s.commit_all("first");
        let json = serde_json::to_value(s.plan(None, &[], false)).unwrap();
        assert!(json.get("commitSha").is_some());
        assert!(json.get("baseCommitSha").is_some());
        assert!(json.get("includeUncommitted").is_some());
        assert!(json.get("totalBytes").is_some());
        assert!(json.get("commit_sha").is_none());
        assert!(json["uploads"][0].get("remotePath").is_some());
    }
}
