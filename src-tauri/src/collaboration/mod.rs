use crate::state::{CollabParticipant, CollabSession};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::broadcast;

/// Oturum içinde yayınlanan event'ler
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CollabEvent {
    /// Katılımcı dizin değiştirdi
    Navigate {
        participant_id: String,
        path: String,
    },
    /// Dosya işlemi gerçekleşti (yükle/sil/yeniden adlandır)
    FileAction {
        participant_id: String,
        action: String,
        path: String,
    },
    /// Yeni katılımcı bağlandı
    ParticipantJoined { participant: CollabParticipant },
    /// Katılımcı ayrıldı
    ParticipantLeft { participant_id: String },
    /// Sohbet mesajı
    Chat {
        participant_id: String,
        message: String,
    },
    /// Tüm katılımcılara ping (canlılık)
    Ping,
}

/// Aktif collaboration kanalları
pub struct CollabChannels {
    /// session_code → broadcast sender
    channels: HashMap<String, broadcast::Sender<CollabEvent>>,
}

impl CollabChannels {
    pub fn new() -> Self {
        Self {
            channels: HashMap::new(),
        }
    }

    pub fn create_channel(&mut self, code: &str) -> broadcast::Receiver<CollabEvent> {
        let (tx, rx) = broadcast::channel(64);
        self.channels.insert(code.to_string(), tx);
        rx
    }

    pub fn subscribe(&self, code: &str) -> Option<broadcast::Receiver<CollabEvent>> {
        self.channels.get(code).map(|tx| tx.subscribe())
    }

    pub fn broadcast(&self, code: &str, event: CollabEvent) {
        if let Some(tx) = self.channels.get(code) {
            let _ = tx.send(event);
        }
    }

    pub fn remove_channel(&mut self, code: &str) {
        self.channels.remove(code);
    }
}

impl Default for CollabChannels {
    fn default() -> Self {
        Self::new()
    }
}

/// Benzersiz 6 karakterli session kodu üret
pub fn generate_code() -> String {
    use std::fmt::Write;
    let id = uuid::Uuid::new_v4();
    let bytes = id.as_bytes();
    let mut code = String::new();
    for b in bytes.iter().take(3) {
        write!(code, "{:02X}", b).unwrap();
    }
    code
}

/// Katılımcı renk paleti
pub const PARTICIPANT_COLORS: &[&str] = &[
    "#ef4444", "#f97316", "#eab308", "#22c55e",
    "#06b6d4", "#6366f1", "#a855f7", "#ec4899",
];

pub fn pick_color(index: usize) -> &'static str {
    PARTICIPANT_COLORS[index % PARTICIPANT_COLORS.len()]
}
