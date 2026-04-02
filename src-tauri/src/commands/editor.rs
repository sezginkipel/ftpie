use crate::state::AppState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

/// Editörde açılacak dosya bilgisi
#[derive(Debug, Serialize)]
pub struct EditorFile {
    pub path: String,
    pub content: String,
    pub language: String,
    /// SHA-256 of original content — değişiklik tespiti için
    pub original_hash: String,
    pub size: usize,
    pub is_binary: bool,
}

/// Dosya kaydetme sonucu
#[derive(Debug, Serialize)]
pub struct SaveResult {
    pub bytes_written: u64,
    pub new_hash: String,
}

/// Uzak dosyayı oku ve editör için döndür
#[tauri::command]
pub async fn editor_open_file(
    session_id: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<EditorFile, String> {
    let session = state
        .get_session(&session_id)
        .ok_or_else(|| format!("oturum bulunamadı: {}", session_id))?;

    let bytes = session.read_file_bytes(&remote_path).await?;

    let is_binary = is_binary_content(&bytes);
    let content = if is_binary {
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes)
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };

    let hash = sha256_hex(&bytes);
    let language = detect_language(&remote_path);

    Ok(EditorFile {
        path: remote_path,
        content,
        language,
        original_hash: hash,
        size: bytes.len(),
        is_binary,
    })
}

/// Editördeki içeriği uzak dosyaya kaydet
#[tauri::command]
pub async fn editor_save_file(
    session_id: String,
    remote_path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<SaveResult, String> {
    let session = state
        .get_session(&session_id)
        .ok_or_else(|| format!("oturum bulunamadı: {}", session_id))?;

    let bytes = content.into_bytes();
    let hash = sha256_hex(&bytes);

    let bytes_written = session.write_file_bytes(&remote_path, bytes).await?;

    tracing::info!(path = %remote_path, bytes = %bytes_written, "dosya editörden kaydedildi");
    Ok(SaveResult {
        bytes_written,
        new_hash: hash,
    })
}

/// İki içerik arasında diff satırları üret (unified diff)
#[tauri::command]
pub fn editor_diff(original: String, current: String) -> Vec<DiffLine> {
    compute_diff(&original, &current)
}

#[derive(Debug, Serialize)]
pub struct DiffLine {
    pub line_number: usize,
    pub kind: DiffKind,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffKind {
    Added,
    Removed,
    Unchanged,
}

fn compute_diff(original: &str, current: &str) -> Vec<DiffLine> {
    let orig_lines: Vec<&str> = original.lines().collect();
    let curr_lines: Vec<&str> = current.lines().collect();

    let mut result = Vec::new();
    let mut i = 0;
    let mut j = 0;

    while i < orig_lines.len() || j < curr_lines.len() {
        match (orig_lines.get(i), curr_lines.get(j)) {
            (Some(&a), Some(&b)) if a == b => {
                result.push(DiffLine { line_number: j + 1, kind: DiffKind::Unchanged, content: b.to_string() });
                i += 1; j += 1;
            }
            (Some(&a), Some(&b)) => {
                result.push(DiffLine { line_number: i + 1, kind: DiffKind::Removed, content: a.to_string() });
                result.push(DiffLine { line_number: j + 1, kind: DiffKind::Added, content: b.to_string() });
                i += 1; j += 1;
            }
            (None, Some(&b)) => {
                result.push(DiffLine { line_number: j + 1, kind: DiffKind::Added, content: b.to_string() });
                j += 1;
            }
            (Some(&a), None) => {
                result.push(DiffLine { line_number: i + 1, kind: DiffKind::Removed, content: a.to_string() });
                i += 1;
            }
            (None, None) => break,
        }
    }
    result
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

fn is_binary_content(data: &[u8]) -> bool {
    let sample = &data[..data.len().min(8000)];
    sample.contains(&0)
}

fn detect_language(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "rs" => "rust",
        "js" | "mjs" | "cjs" => "javascript",
        "ts" | "mts" => "typescript",
        "tsx" => "typescriptreact",
        "jsx" => "javascriptreact",
        "py" => "python",
        "php" => "php",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" | "sass" => "scss",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "md" => "markdown",
        "sql" => "sql",
        "sh" | "bash" => "shell",
        "xml" | "svg" => "xml",
        "go" => "go",
        "rb" => "ruby",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" => "cpp",
        "cs" => "csharp",
        "swift" => "swift",
        "kt" => "kotlin",
        "conf" | "cfg" | "ini" => "ini",
        "dockerfile" => "dockerfile",
        _ => "plaintext",
    }
    .to_string()
}
