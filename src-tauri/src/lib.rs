mod ai;
mod bookmarks;
mod commands;
mod crypto;
mod deploy_history;
mod error;
mod ftp;
mod git;
mod scripting;
mod sftp;
mod state;
mod store_util;
mod transfer;
mod trust;
mod vault;

use state::AppState;

/// Initialize logging before anything else, so a failure during Tauri setup is
/// still recorded. The previous version initialized the subscriber inside
/// `setup` and `unwrap()`ed the filter directive, so a bad `RUST_LOG` panicked
/// the app at launch and early failures went unlogged.
fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,ftpie=debug,ftpie_lib=debug"));

    if let Err(e) = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .try_init()
    {
        eprintln!("ftpie: could not install tracing subscriber: {e}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "ftpie starting up");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            // App
            commands::app::app_version,
            // Connection
            commands::connection::connect,
            commands::connection::disconnect,
            commands::connection::list_sessions,
            // Host trust (TOFU pinning for TLS certs and SSH host keys)
            commands::trust::list_trusted_hosts,
            commands::trust::trust_host,
            commands::trust::forget_trusted_host,
            // Credential vault
            commands::vault::vault_status,
            commands::vault::vault_initialize,
            commands::vault::vault_unlock,
            commands::vault::vault_lock,
            commands::vault::vault_change_password,
            // Remote and local files
            commands::files::list_remote,
            commands::files::stat_remote,
            commands::files::delete_remote,
            commands::files::rename_remote,
            commands::files::mkdir_remote,
            commands::files::chmod_remote,
            commands::files::list_local,
            commands::files::list_drives,
            commands::files::mkdir_local,
            commands::files::delete_local,
            commands::files::rename_local,
            // Transfer queue
            commands::transfers::enqueue_transfers,
            commands::transfers::list_transfers,
            commands::transfers::cancel_transfer,
            commands::transfers::pause_transfer,
            commands::transfers::resume_transfer,
            commands::transfers::clear_finished_transfers,
            commands::transfers::set_max_concurrent_transfers,
            commands::transfers::set_queue_paused,
            // Remote editing
            commands::editor::editor_open_file,
            commands::editor::editor_save_file,
            commands::editor::editor_diff,
            // Git-aware deploy
            commands::git::get_git_status,
            commands::git::list_branches,
            commands::git::list_tags,
            commands::git::deploy_branch,
            commands::git::cancel_deploy,
            commands::git::list_deploy_history,
            commands::git::rollback_deploy,
            // Automation scripts
            commands::scripting::list_scripts,
            commands::scripting::save_script,
            commands::scripting::delete_script,
            commands::scripting::run_script,
            commands::scripting::cancel_script,
            commands::scripting::validate_script,
            // Encrypted bookmarks
            commands::bookmarks::list_bookmarks,
            commands::bookmarks::create_bookmark,
            commands::bookmarks::update_bookmark,
            commands::bookmarks::delete_bookmark,
            commands::bookmarks::connect_bookmark,
            commands::bookmarks::export_bookmarks,
            commands::bookmarks::import_bookmarks,
            // AI assistant
            commands::ai::ai_query,
            commands::ai::ai_apply_action,
            commands::ai::ai_set_key,
            commands::ai::ai_clear_key,
            commands::ai::ai_list_providers,
        ])
        .setup(|app| {
            use tauri::Manager;

            let handle = app.handle().clone();

            // The transfer manager needs a window handle before it can emit
            // progress events, and its dispatcher runs for the app's lifetime.
            app.state::<AppState>().transfers.start(handle.clone());

            // Keep idle control connections alive.
            state::spawn_keepalive(handle);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while starting ftpie")
        .run(|handle, event| {
            // Say goodbye to every server on the way out instead of letting the
            // OS tear the sockets down. Sessions were previously never closed
            // gracefully, on quit or otherwise.
            if matches!(event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                let entries = handle.state::<AppState>().take_all_sessions();
                if entries.is_empty() {
                    return;
                }
                tracing::info!(count = entries.len(), "closing sessions on exit");
                tauri::async_runtime::block_on(async move {
                    for entry in entries {
                        entry.kind.close().await;
                    }
                });
            }
        });
}
