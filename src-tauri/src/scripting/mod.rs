use anyhow::{Context, Result};
use rhai::{Dynamic, Engine, EvalAltResult, Map, Scope, AST};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Script metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Script {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: String,
    pub created_at: String,
    pub last_run: Option<String>,
}

impl Script {
    pub fn new(name: impl Into<String>, source: impl Into<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            description: String::new(),
            source: source.into(),
            created_at: chrono::Utc::now().to_rfc3339(),
            last_run: None,
        }
    }
}

/// Script çalışma logu
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptLog {
    pub timestamp: String,
    pub level: LogLevel,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

/// Shared log collector (script çalışırken log biriktir)
pub type LogCollector = Arc<Mutex<Vec<ScriptLog>>>;

/// ftpie DSL motoru oluşturur ve tüm API fonksiyonlarını kayıt eder
pub fn create_engine(logs: LogCollector) -> Engine {
    let mut engine = Engine::new();

    // --- Temel yardımcılar ---
    let logs_ref = logs.clone();
    engine.register_fn("log", move |msg: String| {
        tracing::info!(script = true, "{}", msg);
        logs_ref.lock().unwrap().push(ScriptLog {
            timestamp: chrono::Utc::now().to_rfc3339(),
            level: LogLevel::Info,
            message: msg,
        });
    });

    let logs_ref = logs.clone();
    engine.register_fn("warn", move |msg: String| {
        tracing::warn!(script = true, "{}", msg);
        logs_ref.lock().unwrap().push(ScriptLog {
            timestamp: chrono::Utc::now().to_rfc3339(),
            level: LogLevel::Warn,
            message: msg,
        });
    });

    engine.register_fn("today", || chrono::Utc::now().format("%Y-%m-%d").to_string());
    engine.register_fn("now", || chrono::Utc::now().to_rfc3339());
    engine.register_fn("env", |key: String| {
        std::env::var(&key).unwrap_or_default()
    });

    // --- FTP API ---
    // Gerçek FTP çağrıları için session_id tabanlı wrapper fonksiyonlar
    // Script içinde: let ftp = ftp_connect("host", 21, "user", "pass");
    //                ftp.upload("/local/file", "/remote/file");
    engine.register_fn("ftp_connect", |host: String, port: i64, user: String, pass: String| -> Dynamic {
        // Bu basit bir stub; gerçek impl Tauri state'e erişim gerektirir.
        // Script runner, AppState'e Arc referansı alarak bu fonksiyonu override eder.
        let mut map = Map::new();
        map.insert("host".into(), Dynamic::from(host));
        map.insert("port".into(), Dynamic::from(port));
        map.insert("user".into(), Dynamic::from(user));
        map.insert("pass".into(), Dynamic::from(pass));
        Dynamic::from(map)
    });

    // --- Dosya yardımcıları ---
    engine.register_fn("read_file", |path: String| -> Result<String, Box<EvalAltResult>> {
        std::fs::read_to_string(&path)
            .map_err(|e| format!("read_file failed: {}", e).into())
    });

    engine.register_fn("write_file", |path: String, content: String| -> Result<(), Box<EvalAltResult>> {
        std::fs::write(&path, content.as_bytes())
            .map_err(|e| format!("write_file failed: {}", e).into())
    });

    engine.register_fn("file_exists", |path: String| -> bool {
        std::path::Path::new(&path).exists()
    });

    // --- String yardımcıları ---
    engine.register_fn("to_kebab", |s: String| {
        s.to_lowercase().replace(' ', "-").replace('_', "-")
    });
    engine.register_fn("to_snake", |s: String| {
        s.to_lowercase().replace(' ', "_").replace('-', "_")
    });
    engine.register_fn("basename", |path: String| {
        std::path::Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or(path)
    });
    engine.register_fn("dirname", |path: String| {
        std::path::Path::new(&path)
            .parent()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
    });

    engine
}

/// Script'i çalıştırır, log listesi ve dönüş değeri döner
pub fn run_script(source: &str) -> Result<(Vec<ScriptLog>, Dynamic)> {
    let logs: LogCollector = Arc::new(Mutex::new(Vec::new()));
    let engine = create_engine(logs.clone());
    let mut scope = Scope::new();

    let result = engine
        .eval_with_scope::<Dynamic>(&mut scope, source)
        .map_err(|e| anyhow::anyhow!("script runtime error: {}", e))?;

    let collected = logs.lock().unwrap().clone();
    Ok((collected, result))
}

/// Script'i sadece derleme doğrulaması yapar (çalıştırmaz)
pub fn validate_script(source: &str) -> Result<Vec<String>> {
    let logs: LogCollector = Arc::new(Mutex::new(Vec::new()));
    let engine = create_engine(logs);
    engine
        .compile(source)
        .map_err(|e| anyhow::anyhow!("syntax error: {}", e))?;
    Ok(vec![])
}

/// Script deposu (disk üzerinde JSON)
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ScriptStore {
    pub scripts: Vec<Script>,
}

impl ScriptStore {
    fn config_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("ftpie")
            .join("scripts.json")
    }

    pub fn load_or_default() -> Self {
        let path = Self::config_path();
        if path.exists() {
            std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            Self::with_examples()
        }
    }

    /// Örnek script'lerle dolu yeni depo
    fn with_examples() -> Self {
        let example = Script {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Örnek: Günlük yedekleme".to_string(),
            description: "Uzak sunucudaki dosyaları yerel backup klasörüne indir".to_string(),
            source: r#"// ftpie otomasyon script'i
// Değişken tanımla
let backup_dir = "C:/backups/" + today();

// Log
log("Yedekleme başladı: " + backup_dir);

// Yapılacak işlemler:
// let conn = ftp_connect(env("FTP_HOST"), 21, env("FTP_USER"), env("FTP_PASS"));
// conn.download_dir("/var/www", backup_dir);

log("Yedekleme tamamlandı");
"#.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            last_run: None,
        };
        Self { scripts: vec![example] }
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, serde_json::to_string_pretty(self)?)
            .context("cannot write scripts")?;
        Ok(())
    }
}
