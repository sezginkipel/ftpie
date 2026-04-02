use crate::deploy_history::{DeployedFileRecord, DeployFileStatus as HistoryFileStatus, DeployRecord};
use crate::git::{self, ChangedFile, FileStatus, GitStatus};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State, Window};

#[tauri::command]
pub async fn get_git_status(repo_path: String) -> Result<GitStatus, String> {
    tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&repo_path);
        git::get_status(path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_branches(repo_path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&repo_path);
        git::list_branches(path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_tags(repo_path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&repo_path);
        git::list_tags(path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Deserialize)]
pub struct DeployArgs {
    pub session_id: String,
    pub repo_path: String,
    pub remote_base_path: String,
    /// Sadece bu ref'ten sonraki değişiklikleri deploy et (opsiyonel)
    pub since_ref: Option<String>,
    /// Hangi dosyaları hariç tut (.ftpieignore mantığıyla)
    #[serde(default)]
    pub exclude_patterns: Vec<String>,
    /// Gerçekten göndermeden önce önizleme modu
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct DeployProgress {
    pub total: usize,
    pub done: usize,
    pub current_file: String,
    pub status: DeployFileStatus,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum DeployFileStatus {
    Uploading,
    Done,
    Skipped,
    Failed { error: String },
}

#[derive(Debug, Serialize)]
pub struct DeployResult {
    pub uploaded: usize,
    pub skipped: usize,
    pub failed: usize,
    pub files: Vec<DeployedFile>,
}

#[derive(Debug, Serialize)]
pub struct DeployedFile {
    pub local_path: String,
    pub remote_path: String,
    pub status: DeployFileStatus,
    pub size: u64,
}

/// Git diff'e göre sadece değişen dosyaları FTP sunucusuna gönderir.
/// Her dosya yüklenirken `deploy://progress` event'i emit eder.
#[tauri::command]
pub async fn deploy_branch(
    args: DeployArgs,
    state: State<'_, AppState>,
    window: Window,
) -> Result<DeployResult, String> {
    // 1. Değişen dosyaları bul
    let repo_path = args.repo_path.clone();
    let since_ref = args.since_ref.clone();
    let excludes = args.exclude_patterns.clone();

    let changed = tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&repo_path);
        let files = if let Some(ref r) = since_ref {
            git::files_changed_since(path, r).map_err(|e| e.to_string())?
        } else {
            git::get_status(path)
                .map_err(|e| e.to_string())?
                .changed_files
        };
        // Hariç tutulanları filtrele
        let filtered: Vec<ChangedFile> = files
            .into_iter()
            .filter(|f| !should_exclude(&f.path, &excludes))
            .filter(|f| !matches!(f.status, FileStatus::Deleted))
            .collect();
        Ok::<_, String>(filtered)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Oturumu bir kez al (Clone = sadece Arc kopyalanır)
    let session = if !args.dry_run {
        Some(
            state
                .get_session(&args.session_id)
                .ok_or_else(|| format!("session not found: {}", args.session_id))?,
        )
    } else {
        None
    };

    let total = changed.len();
    let mut uploaded = 0;
    let mut skipped = 0;
    let mut failed = 0;
    let mut results: Vec<DeployedFile> = Vec::new();

    // 2. Dosyaları yükle
    for (i, changed_file) in changed.iter().enumerate() {
        let local_path = format!("{}/{}", args.repo_path, changed_file.path);
        let remote_path = format!(
            "{}/{}",
            args.remote_base_path.trim_end_matches('/'),
            changed_file.path
        );

        // Progress event gönder
        let _ = window.emit(
            "deploy://progress",
            DeployProgress {
                total,
                done: i,
                current_file: changed_file.path.clone(),
                status: DeployFileStatus::Uploading,
            },
        );

        if args.dry_run {
            skipped += 1;
            results.push(DeployedFile {
                local_path: local_path.clone(),
                remote_path: remote_path.clone(),
                status: DeployFileStatus::Skipped,
                size: 0,
            });
            continue;
        }

        let sess = session.as_ref().unwrap();

        // Remote üst dizini oluştur (zaten varsa hatayı yoksay)
        if let Some(parent) = std::path::Path::new(&remote_path).parent() {
            let parent_str = parent.to_string_lossy().to_string();
            if parent_str != "/" && !parent_str.is_empty() {
                let _ = sess.mkdir(&parent_str).await;
            }
        }

        let result = sess
            .upload_local(std::path::PathBuf::from(&local_path), &remote_path)
            .await
            .map_err(|e| e.to_string());

        match result {
            Ok(size) => {
                uploaded += 1;
                results.push(DeployedFile {
                    local_path,
                    remote_path: remote_path.clone(),
                    status: DeployFileStatus::Done,
                    size,
                });
                let _ = window.emit(
                    "deploy://progress",
                    DeployProgress {
                        total,
                        done: i + 1,
                        current_file: changed_file.path.clone(),
                        status: DeployFileStatus::Done,
                    },
                );
            }
            Err(err) => {
                failed += 1;
                results.push(DeployedFile {
                    local_path,
                    remote_path,
                    status: DeployFileStatus::Failed { error: err.clone() },
                    size: 0,
                });
                let _ = window.emit(
                    "deploy://progress",
                    DeployProgress {
                        total,
                        done: i + 1,
                        current_file: changed_file.path.clone(),
                        status: DeployFileStatus::Failed { error: err },
                    },
                );
            }
        }
    }

    tracing::info!(uploaded, skipped, failed, "deploy complete");

    // 3. Deploy geçmişine kaydet
    if !args.dry_run {
        let host = session
            .as_ref()
            .map(|s| s.host())
            .unwrap_or_else(|| args.session_id.clone());

        let record = DeployRecord {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            server_host: host,
            server_user: String::new(),
            repo_path: args.repo_path.clone(),
            remote_base_path: args.remote_base_path.clone(),
            git_ref: args.since_ref.clone(),
            uploaded,
            skipped,
            failed,
            files: results
                .iter()
                .map(|f| DeployedFileRecord {
                    local_path: f.local_path.clone(),
                    remote_path: f.remote_path.clone(),
                    status: match &f.status {
                        DeployFileStatus::Done => HistoryFileStatus::Done,
                        DeployFileStatus::Skipped => HistoryFileStatus::Skipped,
                        DeployFileStatus::Failed { .. } => HistoryFileStatus::Failed,
                        DeployFileStatus::Uploading => HistoryFileStatus::Failed,
                    },
                    size: f.size,
                })
                .collect(),
        };
        if let Err(e) = crate::deploy_history::save_record(record) {
            tracing::warn!("deploy geçmişi kaydedilemedi: {}", e);
        }
    }

    Ok(DeployResult {
        uploaded,
        skipped,
        failed,
        files: results,
    })
}

fn should_exclude(path: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|p| {
        // Basit glob: *.log, node_modules/, vb.
        if p.starts_with("*.") {
            let ext = &p[1..];
            path.ends_with(ext)
        } else if p.ends_with('/') {
            path.starts_with(p.trim_end_matches('/'))
        } else {
            path.contains(p.as_str())
        }
    })
}
