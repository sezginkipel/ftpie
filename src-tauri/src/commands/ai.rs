//! Tauri commands for the AI assistant.
//!
//! Two rules shape this file:
//!
//! * **No secrets over the IPC boundary.** `ai_query` takes no API key; the key
//!   is read from the vault. `ai_list_providers` reports only *whether* a key
//!   exists. Nothing here logs or returns a key.
//! * **The provider is a closed enum.** An unknown provider name is a
//!   `AppError::Config`, never a URL to send credentials to.

use tauri::State;

use crate::ai::{
    self, AiAction, AiConfig, AiContext, AiProvider, AiProviderInfo, AiRequest, AiResponse,
};
use crate::error::{AppError, AppResult};
use crate::state::{lock_or_recover, AppState};

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiQueryArgs {
    pub prompt: String,
    /// One of `anthropic`, `openai`, `ollama`, `custom`.
    pub provider: String,
    pub model: Option<String>,
    /// Only meaningful for `custom` (and for relocating a local Ollama). It is
    /// validated before use; there is deliberately no `apiKey` field.
    pub base_url: Option<String>,
    pub context: Option<AiContextArgs>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiContextArgs {
    pub remote_path: Option<String>,
    pub local_path: Option<String>,
    #[serde(default)]
    pub selected_files: Vec<String>,
    pub git_branch: Option<String>,
    pub file_listing: Option<Vec<String>>,
}

/// Ask the assistant. The key comes from the vault: if one is stored but the
/// vault is locked, this returns `AppError::VaultLocked` so the UI can prompt.
#[tauri::command]
pub async fn ai_query(args: AiQueryArgs, state: State<'_, AppState>) -> AppResult<AiResponse> {
    let provider = AiProvider::parse(&args.provider)?;
    let base_url = ai::resolve_base_url(provider, args.base_url.as_deref())?;

    let model = args
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or(provider.default_model())
        .to_string();

    // Scoped so the vault guard is dropped before the first await point.
    let api_key = {
        let vault = lock_or_recover(&state.vault);
        ai::load_key(&vault, provider)?
    };
    if provider.requires_key() && api_key.is_none() {
        return Err(AppError::config(format!(
            "No API key is configured for '{provider}'. Add one in AI settings first."
        )));
    }

    let context = args.context.map(|c| AiContext {
        remote_path: c.remote_path,
        local_path: c.local_path,
        selected_files: c.selected_files,
        git_branch: c.git_branch,
        file_listing: c.file_listing,
    });

    let config = AiConfig {
        provider,
        base_url,
        model,
        api_key,
    };

    ai::query(
        &config,
        AiRequest {
            prompt: args.prompt,
            context,
        },
    )
    .await
}

/// Apply one proposed action. Called only after the user confirmed it in the UI.
///
/// The action is re-validated here rather than trusted from the round trip: the
/// value travelled through the frontend, so treat it as input again. Every
/// surviving action touches only the remote server the session is already
/// authenticated to — there is no local filesystem or script path.
#[tauri::command]
pub async fn ai_apply_action(
    action: AiAction,
    session_id: String,
    state: State<'_, AppState>,
) -> AppResult<String> {
    action.validate()?;
    let session = state.require_session(&session_id)?;

    match action {
        AiAction::RenameFile { from, to, .. } => {
            session.rename(&from, &to).await?;
            Ok(format!("Renamed '{from}' to '{to}'"))
        }
        AiAction::MoveFile { from, to, .. } => {
            session.rename(&from, &to).await?;
            Ok(format!("Moved '{from}' to '{to}'"))
        }
        AiAction::DeleteFile { path, .. } => {
            session.delete_file(&path).await?;
            Ok(format!("Deleted '{path}'"))
        }
        AiAction::CreateDirectory { path, .. } => {
            session.mkdir(&path).await?;
            Ok(format!("Created directory '{path}'"))
        }
        AiAction::ChangePermissions { path, mode, .. } => {
            let numeric = ai::parse_octal_mode(&mode)?;
            session.chmod(&path, numeric).await?;
            Ok(format!("Changed permissions of '{path}' to {mode}"))
        }
    }
}

/// Store an API key for a provider in the vault. Requires an unlocked vault.
#[tauri::command]
pub async fn ai_set_key(
    provider: String,
    key: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let provider = AiProvider::parse(&provider)?;
    let vault = lock_or_recover(&state.vault);
    ai::set_key(&vault, provider, &key)
}

/// Forget the stored key for a provider. Does not need the vault unlocked.
#[tauri::command]
pub async fn ai_clear_key(provider: String) -> AppResult<()> {
    ai::clear_key(AiProvider::parse(&provider)?)
}

/// Report which providers have a key configured. Never returns key material.
#[tauri::command]
pub async fn ai_list_providers() -> AppResult<Vec<AiProviderInfo>> {
    ai::list_providers()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_args_deserialize_camel_case_and_reject_an_api_key_field() {
        let args: AiQueryArgs = serde_json::from_str(
            r#"{"prompt":"hi","provider":"openai","model":null,"baseUrl":null,
                 "context":{"remotePath":"/var/www","selectedFiles":["a.txt"],
                            "fileListing":["a.txt","b.txt"]}}"#,
        )
        .unwrap();
        assert_eq!(args.provider, "openai");
        let ctx = args.context.unwrap();
        assert_eq!(ctx.remote_path.as_deref(), Some("/var/www"));
        assert_eq!(ctx.selected_files, vec!["a.txt"]);

        // A key sent by an old frontend build is ignored, not honoured: there is
        // no field for it, so it cannot reach any provider.
        let legacy: AiQueryArgs =
            serde_json::from_str(r#"{"prompt":"hi","provider":"openai","apiKey":"sk-x"}"#).unwrap();
        assert!(legacy.base_url.is_none());
        assert!(!format!("{legacy:?}").contains("sk-x"));
    }

    #[test]
    fn apply_action_rejects_bad_actions_before_touching_a_session() {
        let action = AiAction::ChangePermissions {
            path: "/a".into(),
            mode: "not-octal".into(),
            reason: String::new(),
        };
        assert_eq!(action.validate().unwrap_err().code(), "config");
    }
}
