// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod atomic_file;
mod backup;
mod backup_meta;
mod convert;
mod data_root;
mod dev_mode;
mod managed_notebook;
mod notebook_lock;
mod storage;
mod tree;

use std::path::{Path, PathBuf};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use tree::TreeNode;

#[derive(Clone, serde::Serialize)]
struct BackupProgressPayload {
    request_id: String,
    phase: String,
    done: u32,
    total: u32,
}

fn emit_backup_progress(app: &AppHandle, request_id: &str, phase: &str, done: u32, total: u32) {
    let _ = app.emit(
        "backup-progress",
        BackupProgressPayload {
            request_id: request_id.to_string(),
            phase: phase.to_string(),
            done,
            total,
        },
    );
}

fn snapshot_progress_for(app: AppHandle, request_id: String) -> storage::SnapshotProgressReporter {
    Box::new(move |done, remaining| {
        let total = done.saturating_add(remaining);
        emit_backup_progress(&app, &request_id, "snapshot", done, total);
    })
}

fn phase_reporter_for(app: AppHandle, request_id: String) -> storage::BackupPhaseReporter {
    Box::new(move |phase| {
        emit_backup_progress(&app, &request_id, phase, 0, 0);
    })
}

#[tauri::command]
fn get_tree() -> Result<Vec<TreeNode>, String> {
    storage::fetch_tree_from_db()
}

#[tauri::command]
fn add_node(parent_id: Option<String>, label: String) -> Result<TreeNode, String> {
    storage::add_node(parent_id, label)
}

#[tauri::command]
fn update_node(id: String, new_label: String) -> Result<(), String> {
    storage::update_node(id, new_label)
}

#[tauri::command]
fn delete_node(id: String) -> Result<(), String> {
    storage::delete_node(id)
}

#[tauri::command]
fn move_node(id: String, new_parent_id: Option<String>, new_sort_order: i64) -> Result<(), String> {
    storage::move_node(id, new_parent_id, new_sort_order)
}

#[tauri::command]
fn get_node_content(id: String) -> Result<String, String> {
    storage::get_node_content(id)
}

#[tauri::command]
fn get_node(id: String) -> Result<TreeNode, String> {
    storage::get_node(id)
}

#[tauri::command]
fn update_node_content(id: String, content: String) -> Result<(), String> {
    storage::update_node_content(id, content)
}

#[tauri::command]
fn get_settings() -> Result<storage::PublicSettings, String> {
    storage::get_settings()
}
#[tauri::command]
fn update_settings(
    app: tauri::AppHandle,
    editor_font_family: String,
    minimize_to_tray: bool,
    backup_before_restore: bool,
) -> Result<storage::PublicSettings, String> {
    let settings = storage::update_settings(
        editor_font_family,
        minimize_to_tray,
        backup_before_restore,
    )?;
    apply_minimize_to_tray_mode(&app, minimize_to_tray);
    Ok(settings)
}
#[tauri::command]
fn list_notebooks() -> Result<Vec<String>, String> {
    storage::list_notebooks()
}
#[tauri::command]
fn create_notebook(name: String) -> Result<String, String> {
    storage::create_notebook(name)
}
#[tauri::command]
fn switch_notebook(name: String) -> Result<storage::PublicSettings, String> {
    storage::switch_notebook(name)
}
#[tauri::command]
fn export_json(path: String) -> Result<String, String> {
    storage::export_json(path)
}
#[tauri::command]
fn notebook_counts() -> Result<storage::NotebookCounts, String> {
    storage::notebook_counts()
}
#[tauri::command]
fn export_treenote_json(
    dest_path: String,
) -> Result<convert::treenote_json::ExportSummary, String> {
    let tree = storage::fetch_notebook_export_tree()?;
    convert::treenote_json::export_treenote_json(Path::new(&dest_path), &tree)
}
#[tauri::command]
fn import_treenote_json(
    source_path: String,
    notebook_name: String,
) -> Result<convert::treenote_json::ImportSummary, String> {
    let dest = storage::resolve_import_destination(&notebook_name)?;
    let current = storage::get_settings()?.database_path;
    convert::treenote_json::import_treenote_json(Path::new(&source_path), &dest, &current)
}
#[tauri::command]
fn duplicate_node(id: String) -> Result<TreeNode, String> {
    storage::duplicate_node(id)
}
#[tauri::command]
fn export_branch(id: String, path: String) -> Result<String, String> {
    storage::export_branch(id, path)
}
#[tauri::command]
fn import_flashnote(
    source_path: String,
    notebook_name: String,
) -> Result<convert::flashnote::ImportSummary, String> {
    let dest = storage::resolve_import_destination(&notebook_name)?;
    let current = storage::get_settings()?.database_path;
    convert::flashnote::import_flashnote(Path::new(&source_path), &dest, &current)
}
#[tauri::command]
fn export_flashnote(dest_path: String) -> Result<convert::flashnote::ExportSummary, String> {
    let notes = storage::fetch_all_notes_flat()?
        .into_iter()
        .map(|row| convert::flashnote::TreenoteNote {
            id: row.id,
            parent_id: row.parent_id,
            label: row.label,
            sort_order: row.sort_order,
            content: row.content,
        })
        .collect::<Vec<_>>();
    convert::flashnote::export_flashnote(std::path::Path::new(&dest_path), &notes)
}
#[tauri::command]
fn import_obsidian(
    source_path: String,
    notebook_name: String,
) -> Result<convert::markdown_tree::ImportSummary, String> {
    let dest = storage::resolve_import_destination(&notebook_name)?;
    let current = storage::get_settings()?.database_path;
    convert::obsidian::import_obsidian(Path::new(&source_path), &dest, &current)
}
#[tauri::command]
fn import_joplin(
    source_path: String,
    notebook_name: String,
) -> Result<convert::markdown_tree::ImportSummary, String> {
    let dest = storage::resolve_import_destination(&notebook_name)?;
    let current = storage::get_settings()?.database_path;
    convert::joplin::import_joplin(Path::new(&source_path), &dest, &current)
}
#[tauri::command]
fn run_backup_now(
    app: AppHandle,
    label: Option<String>,
    locked: Option<bool>,
    progress_id: Option<String>,
) -> Result<storage::RunBackupNowResult, String> {
    let progress = progress_id.map(|id| snapshot_progress_for(app.clone(), id));
    storage::run_backup_now(label, locked.unwrap_or(false), progress)
}
#[tauri::command]
fn run_scheduled_backup_if_due() -> Result<Option<storage::RunBackupNowResult>, String> {
    storage::run_scheduled_backup_if_due()
}
#[tauri::command]
fn list_managed_backups() -> Result<storage::ManagedBackupList, String> {
    storage::list_managed_backups()
}
#[tauri::command]
fn set_backup_lock(timestamp: u64, locked: bool) -> Result<storage::ManagedBackupList, String> {
    storage::set_backup_lock(timestamp, locked)
}
#[tauri::command]
fn restore_notebook_from_backup(
    app: AppHandle,
    timestamp: u64,
    create_backup_first: Option<bool>,
    progress_id: Option<String>,
) -> Result<(), String> {
    let snapshot = progress_id
        .as_ref()
        .map(|id| snapshot_progress_for(app.clone(), id.clone()));
    let phase = progress_id.map(|id| phase_reporter_for(app, id));
    storage::restore_notebook_from_backup(timestamp, create_backup_first, snapshot, phase)
}
#[tauri::command]
fn security_status() -> Result<storage::SecurityStatus, String> {
    storage::security_status()
}
#[tauri::command]
fn verify_password(password: String) -> Result<bool, String> {
    storage::verify_password(password)
}
#[tauri::command]
fn set_password(current_password: Option<String>, new_password: String) -> Result<(), String> {
    storage::set_password(current_password, new_password)
}
#[tauri::command]
fn remove_password(current_password: String) -> Result<(), String> {
    storage::remove_password(current_password)
}

#[tauri::command]
fn is_dev_mode() -> bool {
    dev_mode::is_dev_mode()
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    for (_label, window) in app.webview_windows() {
        let _ = window.destroy();
    }
    app.exit(0);
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_skip_taskbar(false);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_main_window_to_tray(window: &tauri::Window) {
    let _ = window.hide();
    let _ = window.unminimize();
}

const MAIN_TRAY_ID: &str = "main-tray";

fn set_tray_visible(app: &tauri::AppHandle, visible: bool) {
    if let Some(tray) = app.tray_by_id(MAIN_TRAY_ID) {
        let _ = tray.set_visible(visible);
    }
}

fn apply_minimize_to_tray_mode(app: &tauri::AppHandle, enabled: bool) {
    set_tray_visible(app, enabled);
    if enabled {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_skip_taskbar(false);
        let hidden = !window.is_visible().unwrap_or(true);
        if hidden {
            show_main_window(app);
        } else if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}

fn show_startup_error(message: &str) {
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("TreeNote")
        .set_description(message)
        .show();
}

const RECOVERY_CREATE: &str = "Create new";
const RECOVERY_CHOOSE: &str = "Choose existing";
const RECOVERY_CANCEL: &str = "Cancel";

fn ensure_picker_directory(dir: &Path) {
    let _ = std::fs::create_dir_all(dir);
}

fn pick_existing_notebook(notebooks_dir: &Path) -> Option<PathBuf> {
    ensure_picker_directory(notebooks_dir);
    rfd::FileDialog::new()
        .add_filter("TreeNote notebook", &["sqlite3"])
        .set_directory(notebooks_dir)
        .pick_file()
}

fn pick_new_notebook(notebooks_dir: &Path) -> Option<PathBuf> {
    ensure_picker_directory(notebooks_dir);
    rfd::FileDialog::new()
        .add_filter("TreeNote notebook", &["sqlite3"])
        .set_directory(notebooks_dir)
        .set_file_name("treenote.sqlite3")
        .save_file()
}

fn choose_recovery_action(message: &str) -> rfd::MessageDialogResult {
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("TreeNote")
        .set_description(message)
        .set_buttons(rfd::MessageButtons::YesNoCancelCustom(
            RECOVERY_CREATE.into(),
            RECOVERY_CHOOSE.into(),
            RECOVERY_CANCEL.into(),
        ))
        .show()
}

fn recover_notebook(
    message: String,
    preserve_settings: Option<storage::AppSettings>,
) -> Result<(), String> {
    let notebooks_dir = storage::notebooks_directory()?;
    loop {
        match choose_recovery_action(&message) {
            rfd::MessageDialogResult::Custom(label) if label == RECOVERY_CREATE => {
                let Some(selected) = pick_new_notebook(&notebooks_dir) else {
                    continue;
                };
                match storage::complete_notebook_creation(&selected, preserve_settings.clone()) {
                    Ok(()) => return Ok(()),
                    Err(error) => show_startup_error(&error),
                }
            }
            rfd::MessageDialogResult::Custom(label) if label == RECOVERY_CHOOSE => {
                let Some(selected) = pick_existing_notebook(&notebooks_dir) else {
                    continue;
                };
                match storage::complete_notebook_recovery(&selected, preserve_settings.clone()) {
                    Ok(()) => return Ok(()),
                    Err(error) => show_startup_error(&error),
                }
            }
            _ => return Err("Notebook selection cancelled.".into()),
        }
    }
}

fn run_startup() -> Result<(), String> {
    match storage::prepare_startup()? {
        storage::StartupAction::Continue => {
            let _ = storage::run_scheduled_backup_if_due();
            Ok(())
        }
        storage::StartupAction::RecoverNotebook {
            message,
            preserve_settings,
        } => {
            recover_notebook(message, preserve_settings)?;
            let _ = storage::run_scheduled_backup_if_due();
            Ok(())
        }
    }
}

fn main() {
    if let Err(message) = run_startup() {
        show_startup_error(&message);
        std::process::exit(1);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            dev_mode::apply_webview_policy(app.handle())?;

            let show_item =
                MenuItem::with_id(app, "tray-show", "Show TreeNote", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let _tray = TrayIconBuilder::with_id(MAIN_TRAY_ID)
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .tooltip("TreeNote")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray-show" => show_main_window(app),
                    "tray-quit" => {
                        let _ = app.emit("request-quit", ());
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            apply_minimize_to_tray_mode(app.handle(), storage::minimize_to_tray_enabled());

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" || !storage::minimize_to_tray_enabled() {
                return;
            }
            if matches!(event, tauri::WindowEvent::Focused(false))
                && window.is_minimized().unwrap_or(false)
            {
                hide_main_window_to_tray(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_tree,
            add_node,
            update_node,
            delete_node,
            move_node,
            get_node_content,
            update_node_content,
            get_node,
            get_settings,
            update_settings,
            list_notebooks,
            create_notebook,
            switch_notebook,
            notebook_counts,
            export_json,
            export_treenote_json,
            import_treenote_json,
            duplicate_node,
            export_branch,
            import_flashnote,
            export_flashnote,
            import_obsidian,
            import_joplin,
            run_backup_now,
            run_scheduled_backup_if_due,
            list_managed_backups,
            set_backup_lock,
            restore_notebook_from_backup,
            security_status,
            verify_password,
            set_password,
            remove_password,
            is_dev_mode,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
