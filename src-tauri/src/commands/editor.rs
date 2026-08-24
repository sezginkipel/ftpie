use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Bytes inspected when guessing whether a file is text.
const SNIFF_LEN: usize = 8192;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    /// UTF-8 text, or base64 when `is_binary` is set.
    pub content: String,
    pub is_binary: bool,
    /// SHA-256 of the raw bytes, used for optimistic concurrency on save.
    pub hash: String,
    pub size: u64,
    pub encoding: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub hash: String,
    pub bytes: u64,
}

#[tauri::command]
pub async fn editor_open_file(
    session_id: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> AppResult<OpenedFile> {
    let session = state.require_session(&session_id)?;
    let bytes = session.read_file_bytes(&remote_path).await?;
    let hash = hash_hex(&bytes);
    let size = bytes.len() as u64;

    match decode_text(&bytes) {
        Some(text) => Ok(OpenedFile {
            content: text,
            is_binary: false,
            hash,
            size,
            encoding: "utf-8".to_string(),
        }),
        None => Ok(OpenedFile {
            content: base64::engine::general_purpose::STANDARD.encode(&bytes),
            is_binary: true,
            hash,
            size,
            encoding: "base64".to_string(),
        }),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveArgs {
    pub session_id: String,
    pub remote_path: String,
    pub content: String,
    #[serde(default)]
    pub is_binary: bool,
    /// Hash observed when the file was opened. When present, the save is
    /// refused if the remote copy changed in the meantime.
    pub expected_hash: Option<String>,
}

#[tauri::command]
pub async fn editor_save_file(args: SaveArgs, state: State<'_, AppState>) -> AppResult<SaveResult> {
    let session = state.require_session(&args.session_id)?;

    // Optimistic concurrency: the old code computed a hash on open and never
    // used it, so two editors silently overwrote each other.
    if let Some(expected) = args.expected_hash.as_deref() {
        match session.read_file_bytes(&args.remote_path).await {
            Ok(current) => {
                let actual = hash_hex(&current);
                if actual != expected {
                    return Err(AppError::conflict(
                        format!(
                            "{} changed on the server since it was opened. \
                             Review the differences before overwriting.",
                            args.remote_path
                        ),
                        Some(actual),
                    ));
                }
            }
            // A file that no longer exists is a create, not a conflict.
            Err(AppError::NotFound { .. }) => {}
            Err(e) => return Err(e),
        }
    }

    // A binary buffer arrives base64-encoded and must be decoded before it is
    // written; the old save path wrote the base64 text straight to the server.
    let bytes = if args.is_binary {
        base64::engine::general_purpose::STANDARD
            .decode(args.content.as_bytes())
            .map_err(|e| AppError::config(format!("invalid base64 payload: {e}")))?
    } else {
        args.content.into_bytes()
    };

    let hash = hash_hex(&bytes);
    let written = session.write_file_bytes(&args.remote_path, bytes).await?;

    Ok(SaveResult {
        hash,
        bytes: written,
    })
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffOp {
    Equal,
    Insert,
    Delete,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub op: DiffOp,
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub lines: Vec<DiffLine>,
    pub insertions: usize,
    pub deletions: usize,
}

/// Real LCS diff. The previous implementation paired lines by index, so a single
/// inserted line marked the entire rest of the file as changed.
#[tauri::command]
pub async fn editor_diff(original: String, modified: String) -> AppResult<DiffResult> {
    use similar::{ChangeTag, TextDiff};

    let diff = TextDiff::from_lines(&original, &modified);
    let mut lines = Vec::new();
    let mut insertions = 0;
    let mut deletions = 0;

    for change in diff.iter_all_changes() {
        let op = match change.tag() {
            ChangeTag::Equal => DiffOp::Equal,
            ChangeTag::Insert => {
                insertions += 1;
                DiffOp::Insert
            }
            ChangeTag::Delete => {
                deletions += 1;
                DiffOp::Delete
            }
        };
        lines.push(DiffLine {
            op,
            old_line: change.old_index().map(|i| i + 1),
            new_line: change.new_index().map(|i| i + 1),
            text: change.value().trim_end_matches('\n').to_string(),
        });
    }

    Ok(DiffResult {
        lines,
        insertions,
        deletions,
    })
}

fn hash_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Decode as UTF-8 text, or report binary. A NUL byte in the sniff window is
/// treated as binary even when the bytes happen to be valid UTF-8.
fn decode_text(bytes: &[u8]) -> Option<String> {
    let window = &bytes[..bytes.len().min(SNIFF_LEN)];
    if window.contains(&0) {
        return None;
    }
    String::from_utf8(bytes.to_vec()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_is_not_binary() {
        assert_eq!(decode_text(b"hello\nworld\n").unwrap(), "hello\nworld\n");
    }

    #[test]
    fn nul_bytes_mark_content_binary() {
        assert!(decode_text(b"PK\x03\x04\x00\x00binary").is_none());
    }

    #[test]
    fn invalid_utf8_is_binary() {
        assert!(decode_text(&[0xff, 0xfe, 0xfd]).is_none());
    }

    #[test]
    fn utf8_multibyte_survives_the_roundtrip() {
        let text = "héllo wörld — naïve café\n";
        assert_eq!(decode_text(text.as_bytes()).unwrap(), text);
    }

    #[test]
    fn hash_is_stable_and_distinguishing() {
        assert_eq!(hash_hex(b"a"), hash_hex(b"a"));
        assert_ne!(hash_hex(b"a"), hash_hex(b"b"));
        assert_eq!(hash_hex(b"").len(), 64);
    }

    #[tokio::test]
    async fn diff_reports_only_the_inserted_line() {
        let original = "one\ntwo\nthree\n".to_string();
        let modified = "one\ninserted\ntwo\nthree\n".to_string();
        let result = editor_diff(original, modified).await.unwrap();

        assert_eq!(result.insertions, 1);
        assert_eq!(result.deletions, 0);
        let inserted: Vec<_> = result
            .lines
            .iter()
            .filter(|l| matches!(l.op, DiffOp::Insert))
            .map(|l| l.text.as_str())
            .collect();
        assert_eq!(inserted, vec!["inserted"]);
    }

    #[tokio::test]
    async fn identical_input_produces_no_changes() {
        let text = "same\ncontent\n".to_string();
        let result = editor_diff(text.clone(), text).await.unwrap();
        assert_eq!(result.insertions, 0);
        assert_eq!(result.deletions, 0);
        assert!(result.lines.iter().all(|l| matches!(l.op, DiffOp::Equal)));
    }
}
