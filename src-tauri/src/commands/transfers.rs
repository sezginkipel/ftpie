use tauri::State;

use crate::error::AppResult;
use crate::state::{lock_or_recover, AppState};
use crate::transfer::{EnqueueRequest, TransferItem};

/// Queue one or more transfers. Directories are expanded server-side with a
/// symlink guard and a depth limit, so the frontend never has to walk a tree.
#[tauri::command]
pub async fn enqueue_transfers(
    request: EnqueueRequest,
    state: State<'_, AppState>,
) -> AppResult<Vec<String>> {
    let session = state.require_session(&request.session_id)?;
    state
        .transfers
        .enqueue(
            session,
            &request.session_id,
            request.items,
            request.max_concurrent,
        )
        .await
}

#[tauri::command]
pub async fn list_transfers(state: State<'_, AppState>) -> AppResult<Vec<TransferItem>> {
    Ok(state.transfers.list())
}

#[tauri::command]
pub async fn cancel_transfer(id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.transfers.cancel(&id)
}

#[tauri::command]
pub async fn pause_transfer(id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.transfers.pause(&id)
}

#[tauri::command]
pub async fn resume_transfer(id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.transfers.resume(&id)
}

#[tauri::command]
pub async fn clear_finished_transfers(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    Ok(state.transfers.clear_finished())
}

#[tauri::command]
pub async fn set_max_concurrent_transfers(
    count: usize,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.transfers.set_max_concurrent(count);
    lock_or_recover(&state.settings).max_concurrent_transfers = count.clamp(1, 16);
    Ok(())
}

/// Hold the whole queue without losing what is already scheduled.
#[tauri::command]
pub async fn set_queue_paused(paused: bool, state: State<'_, AppState>) -> AppResult<()> {
    state.transfers.set_queue_paused(paused);
    Ok(())
}
