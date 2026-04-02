use std::collections::HashMap;
use std::sync::Arc;

use crate::bookmarks::BookmarkStore;
use crate::ftp::client::FtpSession;
use crate::sftp::SftpSession;

// ── Oturum Türü ──────────────────────────────────────────────────────────────

/// FTP ve SFTP oturumlarını tek tip altında birleştirir.
/// Tüm dosya işlemi komutları bu enum üzerinden dispatch edilir.
#[derive(Clone)]
pub enum SessionKind {
    /// Senkron FTP (suppaftp) — spawn_blocking içinde kullanılır
    Ftp(Arc<std::sync::Mutex<FtpSession>>),
    /// Asenkron SFTP (russh + russh-sftp)
    Sftp(Arc<tokio::sync::Mutex<SftpSession>>),
}

impl SessionKind {
    /// Dizin listele
    pub async fn list(&self, path: &str) -> Result<Vec<crate::ftp::RemoteFile>, String> {
        match self {
            SessionKind::Ftp(ftp) => {
                let arc = ftp.clone();
                let p = path.to_string();
                tokio::task::spawn_blocking(move || {
                    arc.lock().unwrap().list(&p).map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())?
            }
            SessionKind::Sftp(sftp) => sftp
                .lock()
                .await
                .list(path)
                .await
                .map_err(|e| e.to_string()),
        }
    }

    /// Dosyayı byte olarak oku
    pub async fn read_file_bytes(&self, remote_path: &str) -> Result<Vec<u8>, String> {
        match self {
            SessionKind::Ftp(ftp) => {
                let arc = ftp.clone();
                let p = remote_path.to_string();
                tokio::task::spawn_blocking(move || {
                    arc.lock().unwrap().read_file_bytes(&p).map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())?
            }
            SessionKind::Sftp(sftp) => sftp
                .lock()
                .await
                .read_file_bytes(remote_path)
                .await
                .map_err(|e| e.to_string()),
        }
    }

    /// Dosyaya byte yaz
    pub async fn write_file_bytes(&self, remote_path: &str, data: Vec<u8>) -> Result<u64, String> {
        match self {
            SessionKind::Ftp(ftp) => {
                let arc = ftp.clone();
                let p = remote_path.to_string();
                tokio::task::spawn_blocking(move || {
                    arc.lock().unwrap().write_file_bytes(&p, &data).map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())?
            }
            SessionKind::Sftp(sftp) => sftp
                .lock()
                .await
                .write_file_bytes(remote_path, &data)
                .await
                .map_err(|e| e.to_string()),
        }
    }

    /// Yerel dosyayı uzak sunucuya yükle
    pub async fn upload_local(
        &self,
        local_path: std::path::PathBuf,
        remote_path: &str,
    ) -> Result<u64, String> {
        match self {
            SessionKind::Ftp(ftp) => {
                let arc = ftp.clone();
                let rp = remote_path.to_string();
                tokio::task::spawn_blocking(move || {
                    arc.lock()
                        .unwrap()
                        .upload_local(&local_path, &rp)
                        .map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())?
            }
            SessionKind::Sftp(sftp) => sftp
                .lock()
                .await
                .upload_local(&local_path, remote_path)
                .await
                .map_err(|e| e.to_string()),
        }
    }

    /// Uzak dosyayı yerel diske indir
    pub async fn download_to_local(
        &self,
        remote_path: &str,
        local_path: std::path::PathBuf,
    ) -> Result<u64, String> {
        match self {
            SessionKind::Ftp(ftp) => {
                let arc = ftp.clone();
                let rp = remote_path.to_string();
                tokio::task::spawn_blocking(move || {
                    arc.lock()
                        .unwrap()
                        .download_to_local(&rp, &local_path)
                        .map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())?
            }
            SessionKind::Sftp(sftp) => sftp
                .lock()
                .await
                .download_to_local(remote_path, &local_path)
                .await
                .map_err(|e| e.to_string()),
        }
    }

    /// Dizin oluştur
    pub async fn mkdir(&self, path: &str) -> Result<(), String> {
        match self {
            SessionKind::Ftp(ftp) => {
                let arc = ftp.clone();
                let p = path.to_string();
                tokio::task::spawn_blocking(move || {
                    arc.lock().unwrap().mkdir(&p).map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())?
            }
            SessionKind::Sftp(sftp) => sftp
                .lock()
                .await
                .mkdir(path)
                .await
                .map_err(|e| e.to_string()),
        }
    }

    /// Dosya sil
    pub async fn delete_file(&self, path: &str) -> Result<(), String> {
        match self {
            SessionKind::Ftp(ftp) => {
                let arc = ftp.clone();
                let p = path.to_string();
                tokio::task::spawn_blocking(move || {
                    arc.lock().unwrap().delete_file(&p).map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())?
            }
            SessionKind::Sftp(sftp) => sftp
                .lock()
                .await
                .delete_file(path)
                .await
                .map_err(|e| e.to_string()),
        }
    }

    /// Dizin sil
    pub async fn delete_dir(&self, path: &str) -> Result<(), String> {
        match self {
            SessionKind::Ftp(ftp) => {
                let arc = ftp.clone();
                let p = path.to_string();
                tokio::task::spawn_blocking(move || {
                    arc.lock().unwrap().delete_dir(&p).map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())?
            }
            SessionKind::Sftp(sftp) => sftp
                .lock()
                .await
                .delete_dir(path)
                .await
                .map_err(|e| e.to_string()),
        }
    }

    /// Yeniden adlandır / taşı
    pub async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        match self {
            SessionKind::Ftp(ftp) => {
                let arc = ftp.clone();
                let f = from.to_string();
                let t = to.to_string();
                tokio::task::spawn_blocking(move || {
                    arc.lock().unwrap().rename(&f, &t).map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())?
            }
            SessionKind::Sftp(sftp) => sftp
                .lock()
                .await
                .rename(from, to)
                .await
                .map_err(|e| e.to_string()),
        }
    }

    /// İzin değiştir (chmod)
    pub async fn chmod(&self, path: &str, permissions: u32) -> Result<(), String> {
        match self {
            SessionKind::Ftp(ftp) => {
                let arc = ftp.clone();
                let p = path.to_string();
                tokio::task::spawn_blocking(move || {
                    arc.lock().unwrap().chmod(&p, permissions).map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())?
            }
            SessionKind::Sftp(sftp) => sftp
                .lock()
                .await
                .chmod(path, permissions)
                .await
                .map_err(|e| e.to_string()),
        }
    }

    /// Bağlantı konfigürasyonu
    pub fn host(&self) -> String {
        match self {
            SessionKind::Ftp(ftp) => ftp.lock().unwrap().config.host.clone(),
            // Sftp için lock almak async gerektirir; bu metot sync olduğu için
            // config'i ayrıca state'de de tutabiliriz. Basitlik için sabit döndür.
            SessionKind::Sftp(_) => String::from("sftp"),
        }
    }
}

// ── Uygulama Durumu ──────────────────────────────────────────────────────────

/// Tauri tarafından yönetilen uygulama durumu
pub struct AppState {
    /// Aktif FTP/SFTP oturumları: session_id → SessionKind
    pub sessions: std::sync::Mutex<HashMap<String, SessionKind>>,
    /// Şifreli bookmark deposu
    pub bookmarks: std::sync::Mutex<BookmarkStore>,
    /// Collaboration oturumları: session_code → katılımcılar
    pub collab_sessions: std::sync::Mutex<HashMap<String, CollabSession>>,
    /// SSH terminal yazıcıları: terminal_id → sender
    pub terminals: std::sync::Mutex<HashMap<String, SshTerminalHandle>>,
    /// WebSocket collaboration sunucu portu (başlatıldıktan sonra set edilir)
    pub ws_port: std::sync::Mutex<Option<u16>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: std::sync::Mutex::new(HashMap::new()),
            bookmarks: std::sync::Mutex::new(BookmarkStore::load_or_default()),
            collab_sessions: std::sync::Mutex::new(HashMap::new()),
            terminals: std::sync::Mutex::new(HashMap::new()),
            ws_port: std::sync::Mutex::new(None),
        }
    }

    /// Oturumu ID'ye göre döndürür (Clone = sadece Arc kopyalanır)
    pub fn get_session(&self, id: &str) -> Option<SessionKind> {
        self.sessions.lock().unwrap().get(id).cloned()
    }

    /// Yeni FTP oturumunu kaydeder, ID döndürür
    pub fn add_ftp_session(&self, session: FtpSession) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let kind = SessionKind::Ftp(Arc::new(std::sync::Mutex::new(session)));
        self.sessions.lock().unwrap().insert(id.clone(), kind);
        id
    }

    /// Yeni SFTP oturumunu kaydeder, ID döndürür
    pub fn add_sftp_session(&self, session: SftpSession) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let kind = SessionKind::Sftp(Arc::new(tokio::sync::Mutex::new(session)));
        self.sessions.lock().unwrap().insert(id.clone(), kind);
        id
    }

    /// Oturumu siler
    pub fn remove_session(&self, id: &str) {
        self.sessions.lock().unwrap().remove(id);
    }

    /// Terminal kaydeder
    pub fn add_terminal(&self, handle: SshTerminalHandle) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.terminals.lock().unwrap().insert(id.clone(), handle);
        id
    }

    /// Terminal alır
    pub fn get_terminal(&self, id: &str) -> Option<SshTerminalHandle> {
        self.terminals.lock().unwrap().get(id).cloned()
    }

    /// Terminal siler
    pub fn remove_terminal(&self, id: &str) {
        self.terminals.lock().unwrap().remove(id);
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

// ── SSH Terminal Handle ───────────────────────────────────────────────────────

/// SSH terminal'e veri göndermek için kanal
#[derive(Clone)]
pub struct SshTerminalHandle {
    /// Terminal stdin'e yazılacak veriler
    pub input_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    /// Pencere boyutu değişikliği: (cols, rows)
    pub resize_tx: tokio::sync::mpsc::Sender<(u32, u32)>,
}

// ── Collaboration Yapıları ────────────────────────────────────────────────────

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
