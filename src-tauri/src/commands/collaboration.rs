use crate::collaboration::{self, CollabEvent};
use crate::state::{AppState, CollabParticipant, CollabSession};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State, Window};

#[derive(Debug, Serialize)]
pub struct CreateSessionResult {
    pub code: String,
    pub session: CollabSession,
}

/// Yeni bir collaboration oturumu başlat
#[tauri::command]
pub fn create_collab_session(
    ftp_session_id: String,
    owner_name: String,
    state: State<'_, AppState>,
) -> Result<CreateSessionResult, String> {
    let code = collaboration::generate_code();
    let owner_id = uuid::Uuid::new_v4().to_string();

    let session = CollabSession {
        code: code.clone(),
        owner_id: owner_id.clone(),
        participants: vec![CollabParticipant {
            id: owner_id.clone(),
            name: owner_name,
            color: collaboration::PARTICIPANT_COLORS[0].to_string(),
            current_path: None,
        }],
        ftp_session_id,
    };

    state
        .collab_sessions
        .lock()
        .unwrap()
        .insert(code.clone(), session.clone());

    tracing::info!(code = %code, "collab session created");
    Ok(CreateSessionResult { code, session })
}

#[derive(Debug, Deserialize)]
pub struct JoinArgs {
    pub code: String,
    pub participant_name: String,
}

/// Mevcut bir collaboration oturumuna katıl
#[tauri::command]
pub fn join_collab_session(
    args: JoinArgs,
    state: State<'_, AppState>,
    window: Window,
) -> Result<CollabSession, String> {
    let mut sessions = state.collab_sessions.lock().unwrap();
    let session = sessions
        .get_mut(&args.code)
        .ok_or_else(|| format!("session not found: {}", args.code))?;

    let index = session.participants.len();
    let new_participant = CollabParticipant {
        id: uuid::Uuid::new_v4().to_string(),
        name: args.participant_name.clone(),
        color: collaboration::pick_color(index).to_string(),
        current_path: None,
    };

    // Diğer katılımcılara bildir
    let _ = window.emit(
        "collab://event",
        serde_json::json!({
            "code": args.code,
            "event": CollabEvent::ParticipantJoined {
                participant: new_participant.clone()
            }
        }),
    );

    session.participants.push(new_participant);
    let result = session.clone();

    tracing::info!(code = %args.code, name = %args.participant_name, "participant joined");
    Ok(result)
}

/// Collaboration oturumundan ayrıl
#[tauri::command]
pub fn leave_collab_session(
    code: String,
    participant_id: String,
    state: State<'_, AppState>,
    window: Window,
) -> Result<(), String> {
    let mut sessions = state.collab_sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&code) {
        session.participants.retain(|p| p.id != participant_id);

        let _ = window.emit(
            "collab://event",
            serde_json::json!({
                "code": code,
                "event": CollabEvent::ParticipantLeft { participant_id: participant_id.clone() }
            }),
        );

        // Oturum boşaldıysa sil
        if session.participants.is_empty() {
            sessions.remove(&code);
        }
    }
    Ok(())
}

/// Collaboration olayı yayınla (navigate, file_action, chat)
#[tauri::command]
pub fn broadcast_collab_event(
    code: String,
    event: CollabEvent,
    state: State<'_, AppState>,
    window: Window,
) -> Result<(), String> {
    let sessions = state.collab_sessions.lock().unwrap();
    if sessions.contains_key(&code) {
        let _ = window.emit(
            "collab://event",
            serde_json::json!({ "code": code, "event": event }),
        );
        Ok(())
    } else {
        Err(format!("session not found: {}", code))
    }
}

/// Aktif collaboration oturumunu döndür
#[tauri::command]
pub fn get_collab_session(
    code: String,
    state: State<'_, AppState>,
) -> Option<CollabSession> {
    state.collab_sessions.lock().unwrap().get(&code).cloned()
}
