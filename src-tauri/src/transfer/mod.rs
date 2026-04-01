//! Smart transfer queue with priority, dependencies, and scheduling

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TransferStatus {
    Queued,
    InProgress,
    Paused,
    Completed,
    Failed { error: String },
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferItem {
    pub id: Uuid,
    pub direction: TransferDirection,
    pub local_path: String,
    pub remote_path: String,
    pub size: u64,
    pub transferred: u64,
    pub status: TransferStatus,
    pub priority: u8, // 0 = düşük, 255 = en yüksek
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub depends_on: Option<Uuid>, // başka transfer tamamlanmadan başlama
    pub speed_bps: Option<u64>,
}

impl TransferItem {
    pub fn new(
        direction: TransferDirection,
        local_path: impl Into<String>,
        remote_path: impl Into<String>,
        size: u64,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            direction,
            local_path: local_path.into(),
            remote_path: remote_path.into(),
            size,
            transferred: 0,
            status: TransferStatus::Queued,
            priority: 128,
            created_at: Utc::now(),
            started_at: None,
            completed_at: None,
            depends_on: None,
            speed_bps: None,
        }
    }

    pub fn progress_percent(&self) -> f32 {
        if self.size == 0 {
            return 100.0;
        }
        (self.transferred as f32 / self.size as f32) * 100.0
    }
}

/// Transfer kuyruğunu yöneten yapı
pub struct TransferQueue {
    items: VecDeque<TransferItem>,
    max_concurrent: usize,
    bandwidth_limit_bps: Option<u64>,
}

impl TransferQueue {
    pub fn new() -> Self {
        Self {
            items: VecDeque::new(),
            max_concurrent: 3,
            bandwidth_limit_bps: None,
        }
    }

    pub fn enqueue(&mut self, item: TransferItem) {
        // Önceliğe göre sırala
        let pos = self
            .items
            .iter()
            .position(|i| i.priority < item.priority)
            .unwrap_or(self.items.len());
        self.items.insert(pos, item);
    }

    pub fn get_all(&self) -> Vec<&TransferItem> {
        self.items.iter().collect()
    }

    pub fn set_bandwidth_limit(&mut self, bps: Option<u64>) {
        self.bandwidth_limit_bps = bps;
    }

    pub fn active_count(&self) -> usize {
        self.items
            .iter()
            .filter(|i| i.status == TransferStatus::InProgress)
            .count()
    }
}

impl Default for TransferQueue {
    fn default() -> Self {
        Self::new()
    }
}
