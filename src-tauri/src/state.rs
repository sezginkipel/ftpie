use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::bookmarks::BookmarkStore;
use crate::ftp::client::FtpSession;

/// Tauri tarafından yönetilen uygulama durumu
pub struct AppState {
    /// Aktif FTP/SFTP oturumları: session_id → session
    pub sessions: Mutex<HashMap<String, Arc<Mutex<FtpSession>>>>,
    /// Şifreli bookmark deposu
    pub bookmarks: Mutex<BookmarkStore>,
    /// Collaboration oturumları: session_code → katılımcılar
    pub collab_sessions: Mutex<HashMap<String, CollabSession>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            bookmarks: Mutex::new(BookmarkStore::load_or_default()),
            collab_sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Oturumu ID'ye göre döndürür
    pub fn get_session(&self, id: &str) -> Option<Arc<Mutex<FtpSession>>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }

    /// Yeni oturumu kaydeder, ID döndürür
    pub fn add_session(&self, session: FtpSession) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.sessions
            .lock()
            .unwrap()
            .insert(id.clone(), Arc::new(Mutex::new(session)));
        id
    }

    /// Oturumu siler
    pub fn remove_session(&self, id: &str) {
        self.sessions.lock().unwrap().remove(id);
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

/// İşbirliği oturumu
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CollabSession {
    pub code: String,
    pub owner_id: String,
    pub participants: Vec<CollabParticipant>,
    pub ftp_session_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CollabParticipant {
    pub id: String,
    pub name: String,
    pub color: String,
    pub current_path: Option<String>,
}
