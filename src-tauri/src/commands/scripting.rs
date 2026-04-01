use crate::scripting::{self, Script, ScriptLog, ScriptStore};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[tauri::command]
pub fn list_scripts(state: State<'_, AppState>) -> Vec<Script> {
    // Not: scripting store AppState içinde değil, bağımsız load
    ScriptStore::load_or_default().scripts
}

#[tauri::command]
pub async fn save_script(script: Script) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut store = ScriptStore::load_or_default();
        if let Some(existing) = store.scripts.iter_mut().find(|s| s.id == script.id) {
            *existing = script;
        } else {
            store.scripts.push(script);
        }
        store.save().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_script(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut store = ScriptStore::load_or_default();
        store.scripts.retain(|s| s.id != id);
        store.save().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize)]
pub struct RunResult {
    pub logs: Vec<ScriptLog>,
    pub return_value: String,
    pub success: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn run_script(source: String) -> RunResult {
    let result = tokio::task::spawn_blocking(move || scripting::run_script(&source)).await;

    match result {
        Ok(Ok((logs, value))) => RunResult {
            logs,
            return_value: value.to_string(),
            success: true,
            error: None,
        },
        Ok(Err(e)) => RunResult {
            logs: vec![],
            return_value: String::new(),
            success: false,
            error: Some(e.to_string()),
        },
        Err(e) => RunResult {
            logs: vec![],
            return_value: String::new(),
            success: false,
            error: Some(e.to_string()),
        },
    }
}

#[derive(Debug, Serialize)]
pub struct ValidateResult {
    pub valid: bool,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn validate_script(source: String) -> ValidateResult {
    let result = tokio::task::spawn_blocking(move || scripting::validate_script(&source)).await;

    match result {
        Ok(Ok(warnings)) => ValidateResult {
            valid: true,
            errors: warnings,
        },
        Ok(Err(e)) => ValidateResult {
            valid: false,
            errors: vec![e.to_string()],
        },
        Err(e) => ValidateResult {
            valid: false,
            errors: vec![e.to_string()],
        },
    }
}
