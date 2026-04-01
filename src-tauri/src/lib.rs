// mod ai;  // temporarily disabled
mod bookmarks;
// mod collaboration;  // temporarily disabled
mod commands;
mod crypto;
mod ftp;
// mod git;  // temporarily disabled
mod scripting;
// mod sftp;  // temporarily disabled
mod state;
mod transfer;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        // --- AppState ---
        .manage(AppState::new())
        // --- Commands ---
        .invoke_handler(tauri::generate_handler![
            // Connection
            commands::connection::connect,
            commands::connection::disconnect,
            // Files
            commands::files::list_remote,
            commands::files::list_local,
            commands::files::upload,
            commands::files::download,
            commands::files::delete_remote,
            commands::files::rename_remote,
            commands::files::mkdir_remote,
            commands::files::chmod_remote,
            // Editor (Feature 6)
            commands::editor::editor_open_file,
            commands::editor::editor_save_file,
            commands::editor::editor_diff,
            // Git deploy (Feature 1) - temporarily disabled
            // commands::git::get_git_status,
            // commands::git::deploy_branch,
            // commands::git::list_branches,
            // commands::git::list_tags,
            // Scripting (Feature 3)
            commands::scripting::list_scripts,
            commands::scripting::save_script,
            commands::scripting::delete_script,
            commands::scripting::run_script,
            commands::scripting::validate_script,
            // Bookmarks (Feature 5)
            commands::bookmarks::list_bookmarks,
            commands::bookmarks::create_bookmark,
            commands::bookmarks::update_bookmark,
            commands::bookmarks::delete_bookmark,
            commands::bookmarks::connect_bookmark,
            commands::bookmarks::export_bookmarks,
            commands::bookmarks::import_bookmarks,
            // AI (Feature 2) - temporarily disabled
            // commands::ai::ai_query,
            // commands::ai::ai_apply_action,
            // Collaboration (Feature 4) - temporarily disabled
            // commands::collaboration::create_collab_session,
            // commands::collaboration::join_collab_session,
            // commands::collaboration::leave_collab_session,
            // commands::collaboration::broadcast_collab_event,
            // commands::collaboration::get_collab_session,
        ])
        .setup(|app| {
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::from_default_env()
                        .add_directive("ftpie=debug".parse().unwrap()),
                )
                .init();
            tracing::info!("ftpie starting up");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ftpie");
}
