//! The automation DSL: a deliberately small, sandboxed Rhai environment.
//!
//! # Threat model
//!
//! Scripts are authored by the user, but the AI assistant can also *propose*
//! script text, and script text arrives from imported files. Treat every script
//! as untrusted input. The previous engine was a straight remote-code-execution
//! surface: `read_file`/`write_file` accepted any absolute path, `env()` handed
//! out the entire process environment (including tokens), there was no operation
//! limit, and `while true {}` pinned a blocking thread for the life of the app.
//!
//! What is enforced now:
//!
//! - **Resource limits** — see [`ScriptLimits`]: bounded operations, call depth,
//!   string, array and map sizes.
//! - **No environment access** — `env()` is gone, with no replacement.
//! - **No module imports** — the default file-based module resolver is replaced by
//!   an empty static one, so `import "…"` cannot reach the filesystem.
//! - **Filesystem confinement** — `read_file`/`write_file` resolve inside a
//!   [`Workspace`] root (`config_dir()/scripts-workspace` by default). Absolute
//!   paths, `..` traversal and *any* symlink on the path are rejected with
//!   [`AppError::Permission`]. Refusing every link, rather than only the ones
//!   that currently point outside, is what closes the dangling-symlink hole:
//!   see [`Workspace::resolve`].
//! - **Cancellation** — an `on_progress` hook polls an `Arc<AtomicBool>`, so a
//!   runaway script can always be stopped and can never pin a thread forever.
//! - **Real remote operations** — the old `ftp_connect` stub returned a map
//!   containing the password and did nothing. Remote work now goes through
//!   [`ScriptHost`], implemented by the command layer against a live session.
//!
//! # Blocking
//!
//! Rhai evaluation is synchronous and can run for seconds. Call [`run_script`]
//! from `tokio::task::spawn_blocking`, and hand it a cancel flag the command
//! layer can flip from `cancel_script`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rhai::{Array, Dynamic, Engine, EvalAltResult, Map, Scope};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::ftp::RemoteFile;
use crate::store_util::{config_dir, config_path, load_json, save_json_atomic};

// ── Host interface ───────────────────────────────────────────────────────────

/// Remote operations a script may perform, implemented by the command layer
/// against the session the script was launched for.
///
/// The scripting module cannot reach `AppState`'s session map without a
/// dependency cycle, so the command layer injects an implementation instead.
/// Implementations are called from the blocking thread running the script.
pub trait ScriptHost: Send + Sync + 'static {
    fn list(&self, path: &str) -> AppResult<Vec<RemoteFile>>;
    fn download(&self, remote: &str, local: &str) -> AppResult<u64>;
    fn upload(&self, local: &str, remote: &str) -> AppResult<u64>;
    fn mkdir(&self, path: &str) -> AppResult<()>;
    fn delete(&self, path: &str) -> AppResult<()>;
    fn log(&self, message: &str);
}

/// A host with no session behind it, used by [`validate_script`].
///
/// It performs **no** IO. Every remote call fails loudly rather than pretending
/// to succeed, so it can never be mistaken for a working session — validation
/// only compiles the script, so these are never reached in practice.
pub struct NoopHost;

impl NoopHost {
    fn refuse<T>(op: &str) -> AppResult<T> {
        Err(AppError::permission(format!(
            "{op} is not available: this script is being validated, not run against a session"
        )))
    }
}

impl ScriptHost for NoopHost {
    fn list(&self, _path: &str) -> AppResult<Vec<RemoteFile>> {
        Self::refuse("ftp_list")
    }
    fn download(&self, _remote: &str, _local: &str) -> AppResult<u64> {
        Self::refuse("ftp_download")
    }
    fn upload(&self, _local: &str, _remote: &str) -> AppResult<u64> {
        Self::refuse("ftp_upload")
    }
    fn mkdir(&self, _path: &str) -> AppResult<()> {
        Self::refuse("ftp_mkdir")
    }
    fn delete(&self, _path: &str) -> AppResult<()> {
        Self::refuse("ftp_delete")
    }
    fn log(&self, _message: &str) {}
}

// ── Sandbox limits ───────────────────────────────────────────────────────────

/// Hard ceilings applied to every engine. Defaults are the production values;
/// tests lower them to keep the suite fast.
#[derive(Debug, Clone, Copy)]
pub struct ScriptLimits {
    pub max_operations: u64,
    pub max_call_levels: usize,
    pub max_string_size: usize,
    pub max_array_size: usize,
    pub max_map_size: usize,
}

impl Default for ScriptLimits {
    fn default() -> Self {
        Self {
            max_operations: 5_000_000,
            max_call_levels: 64,
            max_string_size: 1 << 20,
            max_array_size: 100_000,
            max_map_size: 100_000,
        }
    }
}

// ── Filesystem confinement ───────────────────────────────────────────────────

/// A canonicalized directory that script file IO may never leave.
#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    /// Default root: `config_dir()/scripts-workspace`, created on demand.
    pub fn default_root() -> PathBuf {
        config_dir().join("scripts-workspace")
    }

    /// Create the root if needed and canonicalize it, so later `starts_with`
    /// checks compare like with like (this matters on Windows, where
    /// `canonicalize` yields a `\\?\` extended path).
    pub fn new(root: impl Into<PathBuf>) -> AppResult<Self> {
        let root = root.into();
        std::fs::create_dir_all(&root).map_err(|e| {
            AppError::io(format!(
                "cannot create the script workspace {}: {e}",
                root.display()
            ))
        })?;
        let root = root.canonicalize().map_err(|e| {
            AppError::io(format!(
                "cannot resolve the script workspace {}: {e}",
                root.display()
            ))
        })?;
        Ok(Self { root })
    }

    pub fn open_default() -> AppResult<Self> {
        Self::new(Self::default_root())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Map a script-supplied path to a real path inside the workspace.
    ///
    /// Rejects, with [`AppError::Permission`]:
    /// - absolute paths and drive/UNC prefixes,
    /// - any `..` component,
    /// - **any component that is a symlink**, wherever it points,
    /// - anything that, once symlinks are resolved, lands outside the root.
    ///
    /// The last check alone used to be the whole defence, by canonicalizing the
    /// deepest *existing* ancestor and comparing it to the root. It missed
    /// dangling links: `Path::exists()` follows links, so a symlink whose target
    /// does not exist yet counted as non-existent, fell into the unresolved
    /// tail, was re-attached verbatim, and `write_file` then created the target —
    /// outside the root. Planting the link needs another process, so this is
    /// defence in depth, but it is a real escape.
    ///
    /// So [`Self::reject_symlinks`] now walks every component with
    /// `symlink_metadata`, which does *not* follow links, and refuses **any**
    /// symlink rather than trying to work out which ones are safe. That choice is
    /// deliberate: a link's target can be created, retargeted or swapped between
    /// the check and the write, so no examination of it is worth trusting. A
    /// script sandbox has no need to follow links, and a blanket refusal cannot
    /// be raced. The canonicalize-and-compare check is kept behind it as a second
    /// layer.
    pub fn resolve(&self, requested: &str) -> AppResult<PathBuf> {
        let trimmed = requested.trim();
        if trimmed.is_empty() {
            return Err(AppError::permission(
                "an empty path is not a valid workspace path".to_string(),
            ));
        }

        let rel = Path::new(trimmed);
        if rel.is_absolute() {
            return Err(AppError::permission(format!(
                "'{requested}' is an absolute path; scripts may only touch files inside {}",
                self.root.display()
            )));
        }

        use std::path::Component;
        for component in rel.components() {
            match component {
                Component::Normal(_) | Component::CurDir => {}
                Component::ParentDir => {
                    return Err(AppError::permission(format!(
                        "'{requested}' escapes the script workspace via '..'"
                    )))
                }
                Component::RootDir | Component::Prefix(_) => {
                    return Err(AppError::permission(format!(
                        "'{requested}' is not a relative path inside the script workspace"
                    )))
                }
            }
        }

        self.reject_symlinks(rel, requested)?;

        let joined = self.root.join(rel);

        // Canonicalize the deepest ancestor that exists, then re-attach the tail.
        let mut existing: &Path = joined.as_path();
        let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
        while !existing.exists() {
            let Some(name) = existing.file_name() else {
                return Err(AppError::permission(format!(
                    "'{requested}' cannot be resolved inside the script workspace"
                )));
            };
            tail.push(name);
            match existing.parent() {
                Some(parent) => existing = parent,
                None => {
                    return Err(AppError::permission(format!(
                        "'{requested}' cannot be resolved inside the script workspace"
                    )))
                }
            }
        }

        let real = existing.canonicalize().map_err(|e| {
            AppError::io(format!(
                "cannot resolve '{requested}' inside the script workspace: {e}"
            ))
        })?;
        if !real.starts_with(&self.root) {
            return Err(AppError::permission(format!(
                "'{requested}' resolves to {}, outside the script workspace {}",
                real.display(),
                self.root.display()
            )));
        }

        let mut resolved = real;
        for name in tail.into_iter().rev() {
            resolved.push(name);
        }
        Ok(resolved)
    }

    /// Refuse if any component of `rel`, walked from the root, is a symlink.
    ///
    /// `symlink_metadata` does not follow links, so this sees a link that
    /// `Path::exists()` and `canonicalize` would have dissolved — including a
    /// **dangling** one, which is the case the canonicalize-the-deepest-ancestor
    /// check missed entirely.
    ///
    /// A component that does not exist at all is fine: that is the ordinary
    /// "create this file" case.
    fn reject_symlinks(&self, rel: &Path, requested: &str) -> AppResult<()> {
        let mut probe = self.root.clone();
        for component in rel.components() {
            if matches!(component, std::path::Component::CurDir) {
                continue;
            }
            probe.push(component);
            match std::fs::symlink_metadata(&probe) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(AppError::permission(format!(
                        "'{requested}' goes through the symlink {}; scripts may not follow links \
                         inside the script workspace",
                        probe.display()
                    )))
                }
                _ => {}
            }
        }
        Ok(())
    }
}

// ── Logs and results ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptLog {
    pub timestamp: String,
    pub level: LogLevel,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

/// Shared log sink filled while a script runs.
pub type LogCollector = Arc<Mutex<Vec<ScriptLog>>>;

fn push_log(logs: &LogCollector, level: LogLevel, message: String) {
    logs.lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(ScriptLog {
            timestamp: chrono::Utc::now().to_rfc3339(),
            level,
            message,
        });
}

/// Everything the frontend needs after a run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRun {
    pub logs: Vec<ScriptLog>,
    /// Display form of the script's final expression.
    pub result: String,
    pub duration_ms: u64,
}

// ── Engine construction ──────────────────────────────────────────────────────

/// Convert a host error into a Rhai runtime error, keeping the machine-readable
/// code visible to the user in the script log.
fn to_script_error(e: AppError) -> Box<EvalAltResult> {
    format!("{}: {}", e.code(), e).into()
}

fn remote_file_to_map(file: &RemoteFile) -> Map {
    let mut map = Map::new();
    map.insert("name".into(), Dynamic::from(file.name.clone()));
    map.insert("path".into(), Dynamic::from(file.path.clone()));
    map.insert("size".into(), Dynamic::from(file.size as i64));
    map.insert("is_dir".into(), Dynamic::from(file.is_dir));
    map.insert("is_symlink".into(), Dynamic::from(file.is_symlink));
    map.insert(
        "modified".into(),
        Dynamic::from(file.modified.map(|m| m.to_rfc3339()).unwrap_or_default()),
    );
    map
}

/// Build a sandboxed engine.
///
/// `cancel` is polled on every operation; flipping it aborts the script.
pub fn create_engine(
    host: Arc<dyn ScriptHost>,
    logs: LogCollector,
    workspace: Workspace,
    cancel: Arc<AtomicBool>,
    limits: ScriptLimits,
) -> Engine {
    let mut engine = Engine::new();

    // --- Resource ceilings ---
    engine.set_max_operations(limits.max_operations);
    engine.set_max_call_levels(limits.max_call_levels);
    engine.set_max_string_size(limits.max_string_size);
    engine.set_max_array_size(limits.max_array_size);
    engine.set_max_map_size(limits.max_map_size);

    // Rhai's default module resolver reads files from disk; an empty static
    // resolver makes `import` inert.
    engine.set_module_resolver(rhai::module_resolvers::StaticModuleResolver::new());
    // No dynamic code generation inside an already-sandboxed script.
    engine.disable_symbol("eval");

    // --- Cancellation: checked on every operation, so even `while true {}` stops.
    engine.on_progress(move |_ops| {
        if cancel.load(Ordering::Relaxed) {
            Some(Dynamic::from("cancelled"))
        } else {
            None
        }
    });

    // --- Logging ---
    let sink = logs.clone();
    let log_host = host.clone();
    engine.register_fn("log", move |msg: String| {
        tracing::info!(script = true, "{}", msg);
        log_host.log(&msg);
        push_log(&sink, LogLevel::Info, msg);
    });

    let sink = logs.clone();
    engine.register_fn("warn", move |msg: String| {
        tracing::warn!(script = true, "{}", msg);
        push_log(&sink, LogLevel::Warn, msg);
    });

    // `print` and `debug` would otherwise go to stdout; route them to the log.
    let sink = logs.clone();
    engine.on_print(move |s| push_log(&sink, LogLevel::Info, s.to_string()));
    let sink = logs.clone();
    engine.on_debug(move |s, _src, _pos| push_log(&sink, LogLevel::Info, s.to_string()));

    // --- Time helpers (no environment access; `env()` is deliberately absent) ---
    engine.register_fn("today", || {
        chrono::Utc::now().format("%Y-%m-%d").to_string()
    });
    engine.register_fn("now", || chrono::Utc::now().to_rfc3339());

    // --- Remote operations, bound to the injected session ---
    let h = host.clone();
    engine.register_fn(
        "ftp_list",
        move |path: String| -> Result<Array, Box<EvalAltResult>> {
            let files = h.list(&path).map_err(to_script_error)?;
            Ok(files
                .iter()
                .map(|f| Dynamic::from(remote_file_to_map(f)))
                .collect())
        },
    );

    let h = host.clone();
    let ws = workspace.clone();
    engine.register_fn(
        "ftp_download",
        move |remote: String, local: String| -> Result<i64, Box<EvalAltResult>> {
            // Downloads land in the workspace, never at an arbitrary path.
            let target = ws.resolve(&local).map_err(to_script_error)?;
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| -> Box<EvalAltResult> {
                    format!("ftp_download('{local}') failed: {e}").into()
                })?;
            }
            let bytes = h
                .download(&remote, &target.to_string_lossy())
                .map_err(to_script_error)?;
            Ok(bytes as i64)
        },
    );

    let h = host.clone();
    let ws = workspace.clone();
    engine.register_fn(
        "ftp_upload",
        move |local: String, remote: String| -> Result<i64, Box<EvalAltResult>> {
            let source = ws.resolve(&local).map_err(to_script_error)?;
            let bytes = h
                .upload(&source.to_string_lossy(), &remote)
                .map_err(to_script_error)?;
            Ok(bytes as i64)
        },
    );

    let h = host.clone();
    engine.register_fn(
        "ftp_mkdir",
        move |path: String| -> Result<(), Box<EvalAltResult>> {
            h.mkdir(&path).map_err(to_script_error)
        },
    );

    let h = host.clone();
    engine.register_fn(
        "ftp_delete",
        move |path: String| -> Result<(), Box<EvalAltResult>> {
            h.delete(&path).map_err(to_script_error)
        },
    );

    // --- Confined local file helpers ---
    let ws = workspace.clone();
    engine.register_fn(
        "read_file",
        move |path: String| -> Result<String, Box<EvalAltResult>> {
            let resolved = ws.resolve(&path).map_err(to_script_error)?;
            std::fs::read_to_string(&resolved)
                .map_err(|e| format!("read_file('{path}') failed: {e}").into())
        },
    );

    let ws = workspace.clone();
    engine.register_fn(
        "write_file",
        move |path: String, content: String| -> Result<(), Box<EvalAltResult>> {
            let resolved = ws.resolve(&path).map_err(to_script_error)?;
            if let Some(parent) = resolved.parent() {
                std::fs::create_dir_all(parent).map_err(|e| -> Box<EvalAltResult> {
                    format!("write_file('{path}') failed: {e}").into()
                })?;
            }
            std::fs::write(&resolved, content.as_bytes())
                .map_err(|e| format!("write_file('{path}') failed: {e}").into())
        },
    );

    let ws = workspace.clone();
    engine.register_fn("file_exists", move |path: String| -> bool {
        ws.resolve(&path).map(|p| p.exists()).unwrap_or(false)
    });

    engine.register_fn("workspace_dir", move || {
        workspace.root().to_string_lossy().to_string()
    });

    // --- String / path helpers (pure, no IO) ---
    engine.register_fn("to_kebab", |s: String| {
        s.to_lowercase().replace([' ', '_'], "-")
    });
    engine.register_fn("to_snake", |s: String| {
        s.to_lowercase().replace([' ', '-'], "_")
    });
    engine.register_fn("basename", |path: String| {
        Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or(path)
    });
    engine.register_fn("dirname", |path: String| {
        Path::new(&path)
            .parent()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
    });

    engine
}

/// Map a Rhai failure onto the shared error type.
// The `Box` is not ours to remove: Rhai's evaluation API returns
// `Box<EvalAltResult>`, so taking it by value is what callers already hold.
#[allow(clippy::boxed_local)]
fn map_eval_error(e: Box<EvalAltResult>) -> AppError {
    match *e {
        EvalAltResult::ErrorTerminated(..) => AppError::cancelled(),
        EvalAltResult::ErrorTooManyOperations(..) => AppError::permission(
            "the script exceeded the sandbox operation limit and was stopped".to_string(),
        ),
        EvalAltResult::ErrorDataTooLarge(ref what, ..) => AppError::permission(format!(
            "the script exceeded the sandbox size limit for {what}"
        )),
        EvalAltResult::ErrorStackOverflow(..) => {
            AppError::permission("the script exceeded the sandbox call-depth limit".to_string())
        }
        ref other => AppError::internal(format!("script error: {other}")),
    }
}

/// Run `source` against `host`, with the default workspace and limits.
///
/// # Blocking
/// Synchronous and potentially long-running — call from `spawn_blocking`.
pub fn run_script(
    source: &str,
    host: Arc<dyn ScriptHost>,
    cancel: Arc<AtomicBool>,
) -> AppResult<ScriptRun> {
    run_script_with(
        source,
        host,
        cancel,
        Workspace::open_default()?,
        ScriptLimits::default(),
    )
}

/// Run `source` with an explicit workspace and limits.
pub fn run_script_with(
    source: &str,
    host: Arc<dyn ScriptHost>,
    cancel: Arc<AtomicBool>,
    workspace: Workspace,
    limits: ScriptLimits,
) -> AppResult<ScriptRun> {
    let logs: LogCollector = Arc::new(Mutex::new(Vec::new()));
    let engine = create_engine(host, logs.clone(), workspace, cancel, limits);
    let mut scope = Scope::new();

    let started = std::time::Instant::now();
    let outcome = engine.eval_with_scope::<Dynamic>(&mut scope, source);
    let duration_ms = started.elapsed().as_millis() as u64;

    let collected = logs.lock().unwrap_or_else(|e| e.into_inner()).clone();
    match outcome {
        Ok(value) => Ok(ScriptRun {
            logs: collected,
            result: value.to_string(),
            duration_ms,
        }),
        Err(e) => Err(map_eval_error(e)),
    }
}

/// Compile-only check. Performs no IO and never touches a session: the engine is
/// built with [`NoopHost`] and the script body is never evaluated.
pub fn validate_script(source: &str) -> AppResult<()> {
    let logs: LogCollector = Arc::new(Mutex::new(Vec::new()));
    // A temporary workspace handle is not needed for compilation, but the engine
    // wants one; use the default root without creating files in it.
    let workspace = Workspace {
        root: Workspace::default_root(),
    };
    let engine = create_engine(
        Arc::new(NoopHost),
        logs,
        workspace,
        Arc::new(AtomicBool::new(false)),
        ScriptLimits::default(),
    );
    engine
        .compile(source)
        .map(|_| ())
        .map_err(|e| AppError::config(format!("syntax error: {e}")))
}

// ── Script store ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Script {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub source: String,
    pub created_at: String,
    #[serde(default)]
    pub last_run: Option<String>,
}

impl Script {
    pub fn new(name: impl Into<String>, source: impl Into<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            description: String::new(),
            source: source.into(),
            created_at: chrono::Utc::now().to_rfc3339(),
            last_run: None,
        }
    }
}

/// The bundled example, written against the real host API above.
fn example_script() -> Script {
    Script {
        id: uuid::Uuid::new_v4().to_string(),
        name: "Example: mirror a remote folder".to_string(),
        description: "Lists a remote directory and downloads its files into the script workspace."
            .to_string(),
        source: r#"// ftpie automation example.
// Runs against the session the script was started for.
// Local paths are relative to workspace_dir(); nothing outside it is reachable.

let remote_dir = "/var/www/html";
let local_dir = "backups/" + today();

log("Mirroring " + remote_dir + " into " + workspace_dir() + "/" + local_dir);

let entries = ftp_list(remote_dir);
let downloaded = 0;
let bytes = 0;

for entry in entries {
    if entry.is_dir {
        log("skipping directory " + entry.name);
    } else {
        let target = local_dir + "/" + entry.name;
        bytes += ftp_download(entry.path, target);
        downloaded += 1;
    }
}

write_file(local_dir + "/manifest.txt", "files: " + downloaded + "\nbytes: " + bytes + "\n");
log("Done: " + downloaded + " file(s), " + bytes + " byte(s)");

downloaded
"#
        .to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        last_run: None,
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScriptFile {
    #[serde(default)]
    scripts: Vec<Script>,
}

#[derive(Debug)]
pub struct ScriptStore {
    path: PathBuf,
    pub scripts: Vec<Script>,
    /// Set when the file existed but could not be parsed; blocks writes.
    pub load_failed: bool,
}

impl Default for ScriptStore {
    fn default() -> Self {
        Self::load()
    }
}

impl ScriptStore {
    pub fn load() -> Self {
        Self::load_at(config_path("scripts.json"))
    }

    pub fn load_at(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let seed = !path.exists();
        match load_json::<ScriptFile>(&path) {
            Ok(file) => {
                let scripts = if seed && file.scripts.is_empty() {
                    vec![example_script()]
                } else {
                    file.scripts
                };
                Self {
                    path,
                    scripts,
                    load_failed: false,
                }
            }
            Err(e) => {
                tracing::error!(error = %e, "script store is unreadable; it will not be overwritten");
                Self {
                    path,
                    scripts: Vec::new(),
                    load_failed: true,
                }
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn save(&self) -> AppResult<()> {
        if self.load_failed {
            return Err(AppError::config(format!(
                "{} failed to load and was moved aside; refusing to overwrite it.",
                self.path.display()
            )));
        }
        let file = ScriptFile {
            scripts: self.scripts.clone(),
        };
        save_json_atomic(&self.path, &file)
    }

    pub fn list(&self) -> &[Script] {
        &self.scripts
    }

    pub fn get(&self, id: &str) -> Option<&Script> {
        self.scripts.iter().find(|s| s.id == id)
    }

    /// Insert or replace, then persist. The caller holds the store lock for the
    /// whole operation, so two concurrent saves cannot lose one another's work —
    /// the old code re-read the file per command and raced.
    pub fn upsert(&mut self, script: Script) -> AppResult<()> {
        match self.scripts.iter_mut().find(|s| s.id == script.id) {
            Some(existing) => {
                // Preserve the run history the caller does not send back.
                let last_run = existing.last_run.clone();
                *existing = script;
                if existing.last_run.is_none() {
                    existing.last_run = last_run;
                }
            }
            None => self.scripts.push(script),
        }
        self.save()
    }

    pub fn delete(&mut self, id: &str) -> AppResult<bool> {
        let before = self.scripts.len();
        self.scripts.retain(|s| s.id != id);
        if self.scripts.len() == before {
            return Ok(false);
        }
        self.save()?;
        Ok(true)
    }

    /// Stamp `last_run` and persist.
    pub fn mark_run(&mut self, id: &str) -> AppResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        match self.scripts.iter_mut().find(|s| s.id == id) {
            Some(script) => {
                script.last_run = Some(now);
                self.save()
            }
            None => Err(AppError::not_found(id)),
        }
    }
}

/// Run a stored script and stamp its `last_run`.
///
/// The store lock is taken twice — briefly, to copy the source, and again after
/// the run to record the timestamp — so a long script never holds it.
///
/// # Blocking
/// Call from `spawn_blocking`.
pub fn run_stored_script(
    store: &Mutex<ScriptStore>,
    id: &str,
    host: Arc<dyn ScriptHost>,
    cancel: Arc<AtomicBool>,
) -> AppResult<ScriptRun> {
    let source = {
        let guard = store.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .get(id)
            .map(|s| s.source.clone())
            .ok_or_else(|| AppError::not_found(id))?
    };

    let outcome = run_script(&source, host, cancel);

    // Record the attempt whether or not it succeeded; a failed run is still a run.
    if let Err(e) = store.lock().unwrap_or_else(|e| e.into_inner()).mark_run(id) {
        tracing::warn!(error = %e, script = id, "could not record the script run time");
    }

    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ftpie-script-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn workspace(dir: &Path) -> Workspace {
        Workspace::new(dir.join("ws")).unwrap()
    }

    fn small_limits() -> ScriptLimits {
        ScriptLimits {
            max_operations: 20_000,
            max_call_levels: 8,
            max_string_size: 4096,
            max_array_size: 128,
            max_map_size: 128,
        }
    }

    /// Records what a script asked for, so tests can assert the real calls land.
    #[derive(Default)]
    struct RecordingHost {
        calls: Mutex<Vec<String>>,
    }

    impl ScriptHost for RecordingHost {
        fn list(&self, path: &str) -> AppResult<Vec<RemoteFile>> {
            self.calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(format!("list:{path}"));
            Ok(vec![
                RemoteFile::dir(path, "sub"),
                RemoteFile {
                    size: 12,
                    is_dir: false,
                    ..RemoteFile::dir(path, "index.html")
                },
            ])
        }
        fn download(&self, remote: &str, local: &str) -> AppResult<u64> {
            self.calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(format!("download:{remote}"));
            std::fs::write(local, b"hello").map_err(AppError::from)?;
            Ok(5)
        }
        fn upload(&self, local: &str, remote: &str) -> AppResult<u64> {
            self.calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(format!("upload:{local}->{remote}"));
            Ok(1)
        }
        fn mkdir(&self, path: &str) -> AppResult<()> {
            self.calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(format!("mkdir:{path}"));
            Ok(())
        }
        fn delete(&self, path: &str) -> AppResult<()> {
            self.calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(format!("delete:{path}"));
            Ok(())
        }
        fn log(&self, _message: &str) {}
    }

    fn run(source: &str, dir: &Path) -> AppResult<ScriptRun> {
        run_script_with(
            source,
            Arc::new(RecordingHost::default()),
            Arc::new(AtomicBool::new(false)),
            workspace(dir),
            small_limits(),
        )
    }

    // --- Sandbox: filesystem confinement ---

    #[test]
    fn workspace_rejects_parent_traversal() {
        let dir = temp_dir();
        let ws = workspace(&dir);
        let err = ws.resolve("../escaped.txt").unwrap_err();
        assert_eq!(err.code(), "permission");
        assert!(ws.resolve("nested/../../escaped.txt").is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn workspace_rejects_absolute_paths() {
        let dir = temp_dir();
        let ws = workspace(&dir);
        let absolute = if cfg!(windows) {
            "C:/Windows/System32/drivers/etc/hosts"
        } else {
            "/etc/passwd"
        };
        assert_eq!(ws.resolve(absolute).unwrap_err().code(), "permission");
        assert_eq!(ws.resolve("/tmp/x").unwrap_err().code(), "permission");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn workspace_accepts_paths_inside_the_root() {
        let dir = temp_dir();
        let ws = workspace(&dir);
        let resolved = ws.resolve("nested/deep/file.txt").unwrap();
        assert!(resolved.starts_with(ws.root()));
        assert!(resolved.ends_with("file.txt"));
        assert!(ws.resolve("./file.txt").is_ok());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn script_file_io_is_confined_to_the_workspace() {
        let dir = temp_dir();

        // Inside the root: allowed, and the round trip works.
        let ok = run(
            r#"write_file("notes/a.txt", "hello"); read_file("notes/a.txt")"#,
            &dir,
        )
        .unwrap();
        assert_eq!(ok.result, "hello");

        // Outside: refused, and the escape reason reaches the script author.
        let escaped = run(r#"write_file("../pwned.txt", "x")"#, &dir).unwrap_err();
        assert!(
            escaped.to_string().contains("permission"),
            "unexpected error: {escaped}"
        );
        assert!(!dir.join("pwned.txt").exists());

        std::fs::remove_dir_all(dir).ok();
    }

    /// Plant a symlink, reporting whether the platform allowed it. Creating one
    /// on Windows needs Developer Mode or elevation, so a test that cannot plant
    /// its link skips instead of failing for an unrelated reason.
    fn plant_symlink(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link).is_ok()
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (target, link);
            false
        }
    }

    /// The escape this closes: `Path::exists()` follows links, so a symlink whose
    /// target does not exist yet used to count as "not there", survive into the
    /// unresolved tail, and get re-attached — after which `write_file` created
    /// the target outside the root.
    #[test]
    fn workspace_refuses_to_write_through_a_dangling_symlink() {
        let dir = temp_dir();
        let ws = workspace(&dir);

        let outside = dir.join("pwned.txt");
        let link = ws.root().join("escape.txt");
        if !plant_symlink(&outside, &link) {
            eprintln!("skipping: this platform will not let the test plant a symlink");
            std::fs::remove_dir_all(dir).ok();
            return;
        }
        assert!(!outside.exists(), "the link must start out dangling");

        let err = ws.resolve("escape.txt").unwrap_err();
        assert_eq!(err.code(), "permission");
        assert!(err.to_string().contains("symlink"), "{err}");

        // And through the script surface that actually writes.
        let refused = run(r#"write_file("escape.txt", "pwned")"#, &dir).unwrap_err();
        assert!(
            refused.to_string().contains("permission"),
            "unexpected error: {refused}"
        );
        assert!(
            !outside.exists(),
            "the write followed the link and landed outside the workspace"
        );

        std::fs::remove_dir_all(dir).ok();
    }

    /// Same hole one level up: the link is a *directory* component of the path,
    /// so the file being created is a plain name and only the parent is a link.
    #[test]
    fn workspace_refuses_a_symlinked_directory_component() {
        let dir = temp_dir();
        let ws = workspace(&dir);

        let outside = dir.join("outside-dir");
        std::fs::create_dir_all(&outside).unwrap();
        let link = ws.root().join("bridge");
        if !plant_symlink(&outside, &link) {
            eprintln!("skipping: this platform will not let the test plant a symlink");
            std::fs::remove_dir_all(dir).ok();
            return;
        }

        assert_eq!(
            ws.resolve("bridge/pwned.txt").unwrap_err().code(),
            "permission"
        );
        let refused = run(r#"write_file("bridge/pwned.txt", "pwned")"#, &dir).unwrap_err();
        assert!(
            refused.to_string().contains("permission"),
            "unexpected error: {refused}"
        );
        assert!(!outside.join("pwned.txt").exists());

        std::fs::remove_dir_all(dir).ok();
    }

    /// A resolvable link whose target is inside the root is refused too. This is
    /// the difference between "no symlink may escape" and "no symlink may be
    /// traversed": canonicalize would quietly dissolve this one, leaving nothing
    /// to check, and a target that can be swapped between the check and the write
    /// is not worth examining.
    #[test]
    fn workspace_refuses_even_an_inward_pointing_symlink() {
        let dir = temp_dir();
        let ws = workspace(&dir);

        let inside = ws.root().join("real.txt");
        std::fs::write(&inside, b"hello").unwrap();
        let link = ws.root().join("alias.txt");
        if !plant_symlink(&inside, &link) {
            eprintln!("skipping: this platform will not let the test plant a symlink");
            std::fs::remove_dir_all(dir).ok();
            return;
        }

        assert!(ws.resolve("real.txt").is_ok());
        assert_eq!(ws.resolve("alias.txt").unwrap_err().code(), "permission");

        std::fs::remove_dir_all(dir).ok();
    }

    // --- Sandbox: limits and cancellation ---

    #[test]
    fn runaway_loop_hits_the_operation_limit() {
        let dir = temp_dir();
        let err = run("let i = 0; while true { i += 1; }", &dir).unwrap_err();
        assert_eq!(err.code(), "permission");
        assert!(err.to_string().contains("operation limit"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn cancellation_flag_aborts_a_running_script() {
        let dir = temp_dir();
        // Pre-armed flag: the first progress callback aborts the script.
        let cancel = Arc::new(AtomicBool::new(true));
        let err = run_script_with(
            "let i = 0; while true { i += 1; }",
            Arc::new(RecordingHost::default()),
            cancel,
            workspace(&dir),
            ScriptLimits::default(),
        )
        .unwrap_err();
        assert_eq!(err.code(), "cancelled");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn cancellation_from_another_thread_stops_an_infinite_loop() {
        let dir = temp_dir();
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let flipper = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            flag.store(true, Ordering::Relaxed);
        });

        let err = run_script_with(
            "let i = 0; while true { i += 1; }",
            Arc::new(RecordingHost::default()),
            cancel,
            workspace(&dir),
            // Effectively unlimited, so only cancellation can stop this.
            ScriptLimits {
                max_operations: 0,
                ..ScriptLimits::default()
            },
        )
        .unwrap_err();
        flipper.join().unwrap();
        assert_eq!(err.code(), "cancelled");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn call_depth_is_limited() {
        let dir = temp_dir();
        let err = run("fn f(n) { f(n + 1) } f(0)", &dir).unwrap_err();
        assert_eq!(err.code(), "permission");
        std::fs::remove_dir_all(dir).ok();
    }

    // --- Sandbox: removed capabilities ---

    #[test]
    fn env_function_is_gone() {
        let dir = temp_dir();
        let err = run(r#"env("PATH")"#, &dir).unwrap_err();
        assert!(
            err.to_string().contains("env"),
            "env() must not resolve: {err}"
        );
        // And nothing else exposes the environment either.
        assert!(run(r#"std::env::var("PATH")"#, &dir).is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn source_has_no_env_registration() {
        // Guards against a well-meaning re-introduction of the helper.
        let source = include_str!("mod.rs");
        // The needle is assembled at runtime so this assertion does not match
        // itself in the file it is scanning.
        let needle = format!("register_fn(\"{}\"", "env");
        assert!(
            !source.contains(&needle),
            "env() must never be registered on the script engine"
        );
    }

    #[test]
    fn ftp_connect_stub_is_gone() {
        let dir = temp_dir();
        assert!(run(r#"ftp_connect("h", 21, "u", "p")"#, &dir).is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    // --- Host functions ---

    #[test]
    fn ftp_list_returns_entries_to_the_script() {
        let dir = temp_dir();
        let out = run(
            r#"
                let files = ftp_list("/var/www");
                let names = [];
                for f in files { if !f.is_dir { names.push(f.name); } }
                names[0]
            "#,
            &dir,
        )
        .unwrap();
        assert_eq!(out.result, "index.html");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn ftp_download_writes_into_the_workspace_only() {
        let dir = temp_dir();
        let host = Arc::new(RecordingHost::default());
        let ws = workspace(&dir);

        let run = run_script_with(
            r#"ftp_download("/remote/index.html", "out/index.html")"#,
            host.clone(),
            Arc::new(AtomicBool::new(false)),
            ws.clone(),
            small_limits(),
        )
        .unwrap();
        assert_eq!(run.result, "5");
        assert!(ws.root().join("out").join("index.html").exists());

        // A download aimed outside the workspace never reaches the host.
        let err = run_script_with(
            r#"ftp_download("/remote/index.html", "../../evil.html")"#,
            host.clone(),
            Arc::new(AtomicBool::new(false)),
            ws,
            small_limits(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("permission"));
        let calls = host.calls.lock().unwrap_or_else(|e| e.into_inner()).clone();
        assert_eq!(
            calls.iter().filter(|c| c.starts_with("download:")).count(),
            1
        );

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn mkdir_and_delete_reach_the_host() {
        let dir = temp_dir();
        let host = Arc::new(RecordingHost::default());
        run_script_with(
            r#"ftp_mkdir("/new/dir"); ftp_delete("/old/file");"#,
            host.clone(),
            Arc::new(AtomicBool::new(false)),
            workspace(&dir),
            small_limits(),
        )
        .unwrap();
        let calls = host.calls.lock().unwrap_or_else(|e| e.into_inner()).clone();
        assert!(calls.contains(&"mkdir:/new/dir".to_string()));
        assert!(calls.contains(&"delete:/old/file".to_string()));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn logs_are_collected() {
        let dir = temp_dir();
        let out = run(r#"log("hello"); warn("careful"); 1"#, &dir).unwrap();
        assert_eq!(out.logs.len(), 2);
        assert_eq!(out.logs[0].level, LogLevel::Info);
        assert_eq!(out.logs[1].level, LogLevel::Warn);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn imports_cannot_reach_the_filesystem() {
        let dir = temp_dir();
        assert!(run(r#"import "../../secrets" as s;"#, &dir).is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    // --- Validation ---

    #[test]
    fn validate_accepts_good_syntax_and_rejects_bad() {
        validate_script(r#"let x = 1; log("ok"); x + 1"#).unwrap();
        let err = validate_script("let x = ;").unwrap_err();
        assert_eq!(err.code(), "config");
        assert!(err.to_string().contains("syntax error"));
    }

    #[test]
    fn validate_does_not_execute_or_touch_the_filesystem() {
        let marker = std::env::temp_dir().join("ftpie-validate-must-not-write.txt");
        std::fs::remove_file(&marker).ok();
        // Even a script whose body would fail at runtime must validate cleanly,
        // proving nothing was evaluated.
        validate_script(&format!(
            r#"write_file("{}", "x"); ftp_delete("/");"#,
            marker.display().to_string().replace('\\', "/")
        ))
        .unwrap();
        assert!(!marker.exists());
    }

    #[test]
    fn the_bundled_example_compiles() {
        validate_script(&example_script().source).expect("the shipped example must be valid");
    }

    #[test]
    fn noop_host_refuses_instead_of_silently_succeeding() {
        let host = NoopHost;
        assert_eq!(host.list("/").unwrap_err().code(), "permission");
        assert_eq!(host.mkdir("/x").unwrap_err().code(), "permission");
        assert_eq!(host.delete("/x").unwrap_err().code(), "permission");
        assert_eq!(host.upload("a", "b").unwrap_err().code(), "permission");
        assert_eq!(host.download("a", "b").unwrap_err().code(), "permission");
    }

    // --- Store ---

    #[test]
    fn store_upsert_and_delete_persist_without_reloading() {
        let dir = temp_dir();
        let path = dir.join("scripts.json");
        let mut store = ScriptStore::load_at(&path);
        let seeded = store.scripts.len();
        assert_eq!(seeded, 1, "a fresh store ships one example");

        let script = Script::new("mine", "log(\"hi\");");
        let id = script.id.clone();
        store.upsert(script).unwrap();
        assert_eq!(store.list().len(), seeded + 1);

        let mut edited = store.get(&id).unwrap().clone();
        edited.name = "renamed".into();
        store.upsert(edited).unwrap();
        assert_eq!(store.list().len(), seeded + 1);
        assert_eq!(store.get(&id).unwrap().name, "renamed");

        assert!(store.delete(&id).unwrap());
        assert!(!store.delete(&id).unwrap());

        let reloaded = ScriptStore::load_at(&path);
        assert!(reloaded.get(&id).is_none());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn corrupt_store_refuses_to_save() {
        let dir = temp_dir();
        let path = dir.join("scripts.json");
        std::fs::write(&path, b"}}not json").unwrap();

        let mut store = ScriptStore::load_at(&path);
        assert!(store.load_failed);
        assert_eq!(
            store.upsert(Script::new("x", "1")).unwrap_err().code(),
            "config"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn running_a_stored_script_stamps_last_run() {
        let dir = temp_dir();
        let mut initial = ScriptStore::load_at(dir.join("scripts.json"));
        let script = Script::new("mine", r#"log("hi"); 42"#);
        let id = script.id.clone();
        initial.upsert(script).unwrap();
        assert!(initial.get(&id).unwrap().last_run.is_none());

        let store = Mutex::new(initial);
        let out = run_stored_script(
            &store,
            &id,
            Arc::new(RecordingHost::default()),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert_eq!(out.result, "42");

        let guard = store.lock().unwrap_or_else(|e| e.into_inner());
        assert!(guard.get(&id).unwrap().last_run.is_some());
        assert!(guard.get(&id).unwrap().last_run.as_deref().unwrap().len() > 10);
        drop(guard);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn running_an_unknown_script_is_not_found() {
        let store = Mutex::new(ScriptStore::load_at(temp_dir().join("scripts.json")));
        let err = run_stored_script(
            &store,
            "no-such-id",
            Arc::new(RecordingHost::default()),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap_err();
        assert_eq!(err.code(), "not_found");
    }

    #[test]
    fn script_serializes_camel_case() {
        let json = serde_json::to_value(Script::new("n", "1")).unwrap();
        assert!(json.get("createdAt").is_some());
        assert!(json.get("lastRun").is_some());
        assert!(json.get("created_at").is_none());
    }
}
