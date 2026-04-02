use crate::ai::{self, AiAction, AiConfig, AiContext, AiProvider, AiRequest, AiResponse};
use crate::state::AppState;
use serde::Deserialize;
use tauri::State;

#[derive(Debug, Deserialize)]
pub struct AiQueryArgs {
    pub prompt: String,
    pub provider: String,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub context: Option<AiContextArgs>,
}

#[derive(Debug, Deserialize)]
pub struct AiContextArgs {
    pub remote_path: Option<String>,
    pub local_path: Option<String>,
    pub selected_files: Vec<String>,
    pub git_branch: Option<String>,
    pub file_listing: Option<Vec<String>>,
}

#[tauri::command]
pub async fn ai_query(args: AiQueryArgs) -> Result<AiResponse, String> {
    let provider = match args.provider.as_str() {
        "claude" => AiProvider::Claude,
        "openai" => AiProvider::OpenAi,
        "ollama" => AiProvider::Ollama {
            base_url: "http://localhost:11434".to_string(),
            model: args.model.clone().unwrap_or_else(|| "llama3.2".to_string()),
        },
        other => AiProvider::Custom {
            base_url: other.to_string(),
            api_key: args.api_key.clone(),
        },
    };

    let config = AiConfig {
        provider,
        api_key: args.api_key,
        model: args.model,
    };

    let context = args.context.map(|c| AiContext {
        remote_path: c.remote_path,
        local_path: c.local_path,
        selected_files: c.selected_files,
        git_branch: c.git_branch,
        file_listing: c.file_listing,
    });

    ai::query(&config, AiRequest { prompt: args.prompt, context })
        .await
        .map_err(|e| e.to_string())
}

/// AI'ın önerdiği eylemi uygula (kullanıcı onayından sonra çağrılır)
#[tauri::command]
pub async fn ai_apply_action(
    action: AiAction,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    match action {
        AiAction::RenameFile { from, to, .. } => {
            let session = state.get_session(&session_id).ok_or("session not found")?;
            session.rename(&from, &to).await?;
            Ok("Renamed successfully".to_string())
        }
        AiAction::DeleteFile { path, .. } => {
            let session = state.get_session(&session_id).ok_or("session not found")?;
            session.delete_file(&path).await?;
            Ok("Deleted successfully".to_string())
        }
        AiAction::CreateDirectory { path } => {
            let session = state.get_session(&session_id).ok_or("session not found")?;
            session.mkdir(&path).await?;
            Ok("Directory created".to_string())
        }
        AiAction::MoveFile { from, to, .. } => {
            let session = state.get_session(&session_id).ok_or("session not found")?;
            session.rename(&from, &to).await?;
            Ok("Moved successfully".to_string())
        }
        AiAction::ChangePermissions { path, mode, .. } => {
            let perms = u32::from_str_radix(&mode, 8).map_err(|_| "invalid permission mode")?;
            let session = state.get_session(&session_id).ok_or("session not found")?;
            session.chmod(&path, perms).await?;
            Ok("Permissions changed".to_string())
        }
        AiAction::RunScript { source, .. } => {
            let result = tokio::task::spawn_blocking(move || crate::scripting::run_script(&source))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?;
            Ok(format!("Script ran: {} log entries", result.0.len()))
        }
        AiAction::UploadFile { local, remote } => {
            let session = state.get_session(&session_id).ok_or("session not found")?;
            session
                .upload_local(std::path::PathBuf::from(&local), &remote)
                .await?;
            Ok("File uploaded".to_string())
        }
    }
}
