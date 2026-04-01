use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    Claude,
    OpenAi,
    Ollama { base_url: String, model: String },
    Custom { base_url: String, api_key: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    pub provider: AiProvider,
    pub api_key: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AiRequest {
    pub prompt: String,
    pub context: Option<AiContext>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AiContext {
    pub remote_path: Option<String>,
    pub local_path: Option<String>,
    pub selected_files: Vec<String>,
    pub git_branch: Option<String>,
    pub file_listing: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AiResponse {
    pub message: String,
    pub actions: Vec<AiAction>,
}

/// AI'ın kullanıcı onayı ile uygulayabileceği eylemler
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiAction {
    RenameFile { from: String, to: String, reason: String },
    DeleteFile { path: String, reason: String },
    CreateDirectory { path: String },
    MoveFile { from: String, to: String, reason: String },
    ChangePermissions { path: String, mode: String, reason: String },
    UploadFile { local: String, remote: String },
    RunScript { source: String, description: String },
}

pub async fn query(config: &AiConfig, request: AiRequest) -> Result<AiResponse> {
    match &config.provider {
        AiProvider::Claude => query_claude(config, request).await,
        AiProvider::OpenAi => query_openai(config, request).await,
        AiProvider::Ollama { base_url, model } => {
            query_ollama(base_url, model, config, request).await
        }
        AiProvider::Custom { base_url, api_key } => {
            query_openai_compat(base_url, api_key.as_deref(), config, request).await
        }
    }
}

/// System prompt'u oluşturur — AI'a ftpie bağlamını tanıtır
fn build_system_prompt(context: &Option<AiContext>) -> String {
    let mut prompt = String::from(
        "You are ftpie's built-in AI assistant. You help users manage files on FTP servers.\n\
         You can suggest file operations that the user can approve or reject.\n\
         When suggesting actions, respond with JSON in this format:\n\
         {\"message\": \"explanation\", \"actions\": [{\"type\": \"rename_file\", \"from\": \"...\", \"to\": \"...\", \"reason\": \"...\"}]}\n\
         Action types: rename_file, delete_file, create_directory, move_file, change_permissions, upload_file, run_script.\n\
         If no actions are needed, use an empty actions array.\n\
         Be concise and practical. Always explain why you suggest each action.",
    );

    if let Some(ctx) = context {
        if let Some(ref path) = ctx.remote_path {
            prompt.push_str(&format!("\nCurrent remote path: {}", path));
        }
        if let Some(ref branch) = ctx.git_branch {
            prompt.push_str(&format!("\nGit branch: {}", branch));
        }
        if !ctx.selected_files.is_empty() {
            prompt.push_str(&format!("\nSelected files: {}", ctx.selected_files.join(", ")));
        }
        if let Some(ref listing) = ctx.file_listing {
            let preview: Vec<&String> = listing.iter().take(30).collect();
            prompt.push_str(&format!("\nDirectory listing (first 30): {}", preview.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")));
        }
    }

    prompt
}

fn parse_ai_json(text: &str) -> AiResponse {
    // JSON cevabını parse etmeye çalış; başarısızsa ham mesaj döndür
    let trimmed = text.trim();

    // JSON kod bloğu içinde olabilir
    let json_str = if let Some(start) = trimmed.find("```json") {
        let s = &trimmed[start + 7..];
        s.find("```").map(|end| &s[..end]).unwrap_or(s).trim()
    } else if trimmed.starts_with('{') {
        trimmed
    } else {
        // JSON yok — sadece mesaj
        return AiResponse {
            message: text.to_string(),
            actions: vec![],
        };
    };

    #[derive(Deserialize)]
    struct RawResponse {
        message: String,
        #[serde(default)]
        actions: Vec<AiAction>,
    }

    serde_json::from_str::<RawResponse>(json_str)
        .map(|r| AiResponse {
            message: r.message,
            actions: r.actions,
        })
        .unwrap_or_else(|_| AiResponse {
            message: text.to_string(),
            actions: vec![],
        })
}

async fn query_claude(config: &AiConfig, request: AiRequest) -> Result<AiResponse> {
    let api_key = config
        .api_key
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("Claude API key not set"))?;

    let model = config
        .model
        .as_deref()
        .unwrap_or("claude-sonnet-4-6");

    let client = Client::new();

    #[derive(Serialize)]
    struct ClaudeRequest {
        model: String,
        max_tokens: u32,
        system: String,
        messages: Vec<ClaudeMessage>,
    }

    #[derive(Serialize)]
    struct ClaudeMessage {
        role: String,
        content: String,
    }

    #[derive(Deserialize)]
    struct ClaudeResponse {
        content: Vec<ClaudeContent>,
    }

    #[derive(Deserialize)]
    struct ClaudeContent {
        text: String,
    }

    let body = ClaudeRequest {
        model: model.to_string(),
        max_tokens: 1024,
        system: build_system_prompt(&request.context),
        messages: vec![ClaudeMessage {
            role: "user".to_string(),
            content: request.prompt,
        }],
    };

    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .context("Claude API request failed")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!("Claude API error {}: {}", status, text));
    }

    let claude_resp: ClaudeResponse = resp
        .json()
        .await
        .context("failed to parse Claude response")?;

    let text = claude_resp
        .content
        .into_iter()
        .next()
        .map(|c| c.text)
        .unwrap_or_default();

    Ok(parse_ai_json(&text))
}

async fn query_openai(config: &AiConfig, request: AiRequest) -> Result<AiResponse> {
    let api_key = config
        .api_key
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("OpenAI API key not set"))?;

    let model = config.model.as_deref().unwrap_or("gpt-4o");

    query_openai_compat(
        "https://api.openai.com/v1",
        Some(api_key),
        &AiConfig {
            provider: AiProvider::OpenAi,
            api_key: config.api_key.clone(),
            model: Some(model.to_string()),
        },
        request,
    )
    .await
}

async fn query_openai_compat(
    base_url: &str,
    api_key: Option<&str>,
    config: &AiConfig,
    request: AiRequest,
) -> Result<AiResponse> {
    let model = config.model.as_deref().unwrap_or("gpt-4o");
    let client = Client::new();

    #[derive(Serialize)]
    struct OaiRequest {
        model: String,
        messages: Vec<OaiMessage>,
        max_tokens: u32,
    }
    #[derive(Serialize)]
    struct OaiMessage {
        role: String,
        content: String,
    }
    #[derive(Deserialize)]
    struct OaiResponse {
        choices: Vec<OaiChoice>,
    }
    #[derive(Deserialize)]
    struct OaiChoice {
        message: OaiMsg,
    }
    #[derive(Deserialize)]
    struct OaiMsg {
        content: String,
    }

    let mut messages = vec![OaiMessage {
        role: "system".to_string(),
        content: build_system_prompt(&request.context),
    }];
    messages.push(OaiMessage {
        role: "user".to_string(),
        content: request.prompt,
    });

    let mut req_builder = client
        .post(format!("{}/chat/completions", base_url.trim_end_matches('/')))
        .header("content-type", "application/json");

    if let Some(key) = api_key {
        req_builder = req_builder.bearer_auth(key);
    }

    let resp = req_builder
        .json(&OaiRequest {
            model: model.to_string(),
            messages,
            max_tokens: 1024,
        })
        .send()
        .await
        .context("OpenAI-compat API request failed")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!("API error {}: {}", status, text));
    }

    let oai_resp: OaiResponse = resp.json().await.context("failed to parse API response")?;
    let text = oai_resp
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .unwrap_or_default();

    Ok(parse_ai_json(&text))
}

async fn query_ollama(
    base_url: &str,
    model: &str,
    config: &AiConfig,
    request: AiRequest,
) -> Result<AiResponse> {
    let client = Client::new();

    #[derive(Serialize)]
    struct OllamaRequest {
        model: String,
        prompt: String,
        system: String,
        stream: bool,
    }
    #[derive(Deserialize)]
    struct OllamaResponse {
        response: String,
    }

    let resp = client
        .post(format!("{}/api/generate", base_url.trim_end_matches('/')))
        .json(&OllamaRequest {
            model: model.to_string(),
            prompt: request.prompt,
            system: build_system_prompt(&request.context),
            stream: false,
        })
        .send()
        .await
        .context("Ollama request failed")?;

    let ollama_resp: OllamaResponse = resp.json().await.context("Ollama parse failed")?;
    Ok(parse_ai_json(&ollama_resp.response))
}
