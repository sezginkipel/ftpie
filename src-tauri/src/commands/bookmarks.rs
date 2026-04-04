use crate::bookmarks::Bookmark;
use crate::ftp::Protocol;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[tauri::command]
pub fn list_bookmarks(state: State<'_, AppState>) -> Vec<Bookmark> {
    state.bookmarks.lock().unwrap().bookmarks.clone()
}

#[derive(Debug, Deserialize)]
pub struct CreateBookmarkArgs {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub master_password: Option<String>,
    pub protocol: String,
    pub remote_path: Option<String>,
    pub local_path: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[tauri::command]
pub fn create_bookmark(
    args: CreateBookmarkArgs,
    state: State<'_, AppState>,
) -> Result<Bookmark, String> {
    let protocol = parse_protocol(&args.protocol)?;
    let mut bm = Bookmark::new(&args.name, &args.host, args.port, &args.username, protocol);

    if let Some(ref rp) = args.remote_path {
        bm.remote_path = rp.clone();
    }
    bm.local_path = args.local_path;
    bm.tags = args.tags.unwrap_or_default();

    // Parolayı şifrele
    if let (Some(pass), Some(master)) = (&args.password, &args.master_password) {
        bm.set_password(pass, master).map_err(|e| e.to_string())?;
    }

    let mut store = state.bookmarks.lock().unwrap();
    let created = store.add(bm).clone();
    store.save().map_err(|e| e.to_string())?;

    Ok(created)
}

#[tauri::command]
pub fn update_bookmark(
    bookmark: Bookmark,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut store = state.bookmarks.lock().unwrap();
    if store.update(bookmark) {
        store.save().map_err(|e| e.to_string())
    } else {
        Err("bookmark not found".to_string())
    }
}

#[tauri::command]
pub fn delete_bookmark(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut store = state.bookmarks.lock().unwrap();
    if store.delete(&id) {
        store.save().map_err(|e| e.to_string())
    } else {
        Err("bookmark not found".to_string())
    }
}

/// Bookmark'ı master password ile çözüp bağlantı kurar
#[tauri::command]
pub async fn connect_bookmark(
    id: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let bookmark = {
        let store = state.bookmarks.lock().unwrap();
        store.get(&id).cloned().ok_or("bookmark not found")?
    };

    // Parolayı çöz
    let password = bookmark
        .get_password(&master_password)
        .map_err(|e| format!("cannot decrypt password: {}", e))?;

    // connect komutunu yeniden kullan
    let protocol_str = match bookmark.protocol {
        crate::ftp::Protocol::Ftp => "ftp",
        crate::ftp::Protocol::Ftps => "ftps",
        crate::ftp::Protocol::FtpsImplicit => "ftps_implicit",
        crate::ftp::Protocol::Sftp => "sftp",
        crate::ftp::Protocol::WebDav => "webdav",
        crate::ftp::Protocol::S3 => "s3",
    };

    let args = crate::commands::connection::ConnectArgs {
        host: bookmark.host,
        port: bookmark.port,
        username: bookmark.username,
        password,
        protocol: protocol_str.to_string(),
        passive_mode: Some(true),
        private_key_path: None,
        key_passphrase: None,
    };

    crate::commands::connection::connect(args, state).await.map(|r| r.session_id)
}

/// Tüm bookmark'ları şifreli JSON olarak export eder
#[tauri::command]
pub fn export_bookmarks(
    master_password: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let store = state.bookmarks.lock().unwrap();
    store
        .export_encrypted(&master_password)
        .map_err(|e| e.to_string())
}

/// Şifreli JSON'dan bookmark import eder
#[tauri::command]
pub fn import_bookmarks(
    encrypted_json: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let mut store = state.bookmarks.lock().unwrap();
    let count = store
        .import_encrypted(&encrypted_json, &master_password)
        .map_err(|e| e.to_string())?;
    store.save().map_err(|e| e.to_string())?;
    Ok(count)
}

fn parse_protocol(s: &str) -> Result<Protocol, String> {
    match s {
        "ftp" => Ok(Protocol::Ftp),
        "ftps" => Ok(Protocol::Ftps),
        "ftps_implicit" => Ok(Protocol::FtpsImplicit),
        "sftp" => Ok(Protocol::Sftp),
        "webdav" => Ok(Protocol::WebDav),
        "s3" => Ok(Protocol::S3),
        _ => Err(format!("unknown protocol: {}", s)),
    }
}
