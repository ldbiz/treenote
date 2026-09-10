use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use once_cell::sync::{Lazy, OnceCell};
use rusqlite::backup::{Backup, StepResult};
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::Duration;
use uuid::Uuid;

use crate::backup::{
    backup_filename_for_timestamp, backup_snapshot_temp_filename, is_backup_due,
    list_managed_backup_timestamps, managed_notebook_dir, now_secs as backup_now_secs,
    prune_managed_backups, PruneOutcome,
};
use crate::backup_meta::{
    self, forget_missing, meta_for_timestamp, metadata_warning, read_index, set_entry, set_lock,
    IndexReadResult,
};
use crate::atomic_file;
use crate::data_root::{self, DEFAULT_NOTEBOOK_FILENAME};
use crate::managed_notebook;
use crate::notebook_lock::{self, NotebookLock};
use crate::tree::TreeNode;

const CREATE_NOTES_TABLE_SQL: &str = "
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    label TEXT NOT NULL,
    is_expanded INTEGER,
    sort_order INTEGER NOT NULL,
    content TEXT
);
CREATE INDEX IF NOT EXISTS notes_parent_id_idx ON notes(parent_id);";

const NOTES_TABLE: &str = "notes";
const NOTES_COLUMNS: &[&str] = &[
    "id",
    "parent_id",
    "label",
    "is_expanded",
    "sort_order",
    "content",
];

const RESTORE_ATTACH_ALIAS: &str = "restore_src";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub database_path: String,
    #[serde(default = "default_backup_interval_hours")]
    pub backup_interval_hours: u64,
    #[serde(default = "default_backup_retention")]
    pub backup_retention: usize,
    pub last_backup_at: Option<u64>,
    pub password_hash: Option<String>,
    pub editor_font_family: String,
    #[serde(default = "default_minimize_to_tray")]
    pub minimize_to_tray: bool,
    #[serde(default = "default_backup_before_restore")]
    pub backup_before_restore: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct PublicSettings {
    pub database_path: String,
    pub export_folder: String,
    pub editor_font_family: String,
    pub minimize_to_tray: bool,
    pub backup_before_restore: bool,
}

impl AppSettings {
    fn placeholder() -> Self {
        Self {
            database_path: String::new(),
            backup_interval_hours: 24,
            backup_retention: 7,
            last_backup_at: None,
            password_hash: None,
            editor_font_family: "system".to_string(),
            minimize_to_tray: true,
            backup_before_restore: true,
        }
    }
}

fn public_settings_from(s: AppSettings) -> Result<PublicSettings, String> {
    Ok(PublicSettings {
        database_path: s.database_path,
        export_folder: path_to_setting(&current_exports_dir()?),
        editor_font_family: s.editor_font_family,
        minimize_to_tray: s.minimize_to_tray,
        backup_before_restore: s.backup_before_restore,
    })
}

#[derive(Debug, Serialize)]
pub struct SecurityStatus {
    pub password_configured: bool,
}

static DATA_ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);

fn remember_data_root(root: PathBuf) {
    if let Ok(mut stored) = DATA_ROOT.lock() {
        *stored = Some(root);
    }
}

fn current_data_root() -> Result<PathBuf, String> {
    if let Ok(stored) = DATA_ROOT.lock() {
        if let Some(root) = stored.as_ref() {
            return Ok(root.clone());
        }
    }
    data_root::resolve_data_root()
}

fn current_notebooks_dir() -> Result<PathBuf, String> {
    Ok(data_root::notebooks_dir(&current_data_root()?))
}

fn current_backups_dir() -> Result<PathBuf, String> {
    Ok(data_root::backups_dir(&current_data_root()?))
}

fn current_exports_dir() -> Result<PathBuf, String> {
    Ok(data_root::exports_dir(&current_data_root()?))
}

pub fn notebooks_directory() -> Result<PathBuf, String> {
    current_notebooks_dir()
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(data_root::settings_path(&current_data_root()?))
}

fn default_backup_interval_hours() -> u64 {
    24
}
fn default_backup_retention() -> usize {
    7
}

fn default_minimize_to_tray() -> bool {
    true
}

fn default_backup_before_restore() -> bool {
    true
}

fn new_password_hash(password: &str) -> Result<String, String> {
    // App-lock only: this Argon2id PHC string gates UI access. The SQLite database file is not encrypted.
    let salt_bytes = Uuid::new_v4().into_bytes();
    let salt = SaltString::encode_b64(&salt_bytes).map_err(|e| e.to_string())?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| e.to_string())
}

fn verify_password_hash(password: &str, encoded_hash: &str) -> Result<bool, String> {
    let parsed_hash = PasswordHash::new(encoded_hash).map_err(|e| e.to_string())?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok())
}

fn ensure_db_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(CREATE_NOTES_TABLE_SQL)
}

fn default_settings_on(data_root: &Path) -> AppSettings {
    AppSettings {
        database_path: path_to_setting(&data_root::default_notebook_path(data_root)),
        backup_interval_hours: 24,
        backup_retention: 7,
        last_backup_at: None,
        password_hash: None,
        editor_font_family: "system".to_string(),
        minimize_to_tray: true,
        backup_before_restore: true,
    }
}

fn path_to_setting(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn normalize_settings_on(mut s: AppSettings, data_root: &Path) -> AppSettings {
    let default = default_settings_on(data_root);
    if s.database_path.is_empty() {
        s.database_path = default.database_path;
    }
    if s.backup_interval_hours == 0 {
        s.backup_interval_hours = 24;
    }
    if s.backup_retention == 0 {
        s.backup_retention = 7;
    }
    if s.editor_font_family.is_empty() {
        s.editor_font_family = "system".into();
    }
    s
}

enum SettingsFileState {
    Absent,
    Valid(AppSettings),
    Corrupt,
}

fn read_settings_file_at(path: &Path) -> SettingsFileState {
    if !path.is_file() {
        return SettingsFileState::Absent;
    }
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return SettingsFileState::Corrupt,
    };
    match serde_json::from_str::<AppSettings>(&content) {
        Ok(s) => SettingsFileState::Valid(s),
        Err(_) => SettingsFileState::Corrupt,
    }
}

fn probe_valid_treenote_notebook(path: &Path) -> Result<(), String> {
    let read_only = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Failed to open notebook: {}", e))?;
    validate_existing_notebook_schema(&read_only)
}

struct StartupFs {
    data_root: PathBuf,
}

impl StartupFs {
    fn settings_path(&self) -> PathBuf {
        data_root::settings_path(&self.data_root)
    }

    fn notebooks_dir(&self) -> PathBuf {
        data_root::notebooks_dir(&self.data_root)
    }
}

fn production_startup_fs() -> Result<StartupFs, String> {
    let data_root = data_root::resolve_data_root()?;
    Ok(StartupFs { data_root })
}

fn write_settings_json_atomically(path: &Path, json: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid settings path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(
        "{}.tmp.{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("settings.json"),
        Uuid::new_v4()
    ));
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    let result = atomic_file::atomic_replace_file(&tmp, path);
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn save_settings_to_path(path: &Path, settings: &AppSettings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    write_settings_json_atomically(path, &json)
}

fn save_settings_to_disk(settings: &AppSettings) -> Result<(), String> {
    save_settings_to_path(&settings_path()?, settings)
}

fn candidate_settings_for_notebook(
    selected_path: &Path,
    preserve_settings: Option<AppSettings>,
    data_root: &Path,
) -> AppSettings {
    let mut settings = preserve_settings.unwrap_or_else(|| default_settings_on(data_root));
    settings.database_path = path_to_setting(selected_path);
    normalize_settings_on(settings, data_root)
}

fn persist_recovery_candidate(
    selected_path: &Path,
    preserve_settings: Option<AppSettings>,
    persist: impl FnOnce(&AppSettings) -> Result<(), String>,
) -> Result<AppSettings, String> {
    let root = current_data_root()?;
    let settings = candidate_settings_for_notebook(selected_path, preserve_settings, &root);
    persist(&settings)?;
    Ok(settings)
}

fn persist_recovered_settings_to_disk(settings: &AppSettings) -> Result<(), String> {
    save_settings_to_disk(settings)
}

struct PreparedRecoveryNotebook {
    lock: NotebookLock,
    connection: Connection,
    created_path: Option<PathBuf>,
}

fn abandon_prepared_recovery(prepared: PreparedRecoveryNotebook) {
    let created_path = prepared.created_path.clone();
    drop(prepared.connection);
    drop(prepared.lock);
    if let Some(path) = created_path {
        let _ = fs::remove_file(path);
    }
}

fn commit_prepared_recovery(
    prepared: PreparedRecoveryNotebook,
    settings: AppSettings,
) -> Result<(), String> {
    install_notebook(prepared.lock, prepared.connection)?;
    let mut stored = SETTINGS.lock().map_err(|e| e.to_string())?;
    *stored = settings;
    Ok(())
}

pub static SETTINGS: Lazy<Mutex<AppSettings>> =
    Lazy::new(|| Mutex::new(AppSettings::placeholder()));
static DB_CONNECTION: OnceCell<Mutex<Connection>> = OnceCell::new();
static NOTEBOOK_LOCK: Mutex<Option<NotebookLock>> = Mutex::new(None);

fn db_connection() -> Result<MutexGuard<'static, Connection>, String> {
    DB_CONNECTION
        .get()
        .ok_or_else(|| "Notebook is not open".to_string())?
        .lock()
        .map_err(|e| e.to_string())
}

fn open_or_create_notebook(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("Failed to open notebook: {}", e))?;
    ensure_db_schema(&conn).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn validate_existing_notebook_schema(conn: &Connection) -> Result<(), String> {
    if !notes_table_exists(conn)? {
        return Err("This file is not a TreeNote notebook.".into());
    }
    let columns = notes_column_names(conn, NOTES_TABLE)?;
    for required in NOTES_COLUMNS {
        if !columns.iter().any(|c| c == required) {
            return Err("This file is not a TreeNote notebook.".into());
        }
    }
    Ok(())
}

fn open_notebook_for_recovery(path: &Path) -> Result<Connection, String> {
    if !path.is_file() {
        return Err(format!("Notebook not found: {}", path.display()));
    }
    {
        let read_only = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("Failed to open notebook: {}", e))?;
        validate_existing_notebook_schema(&read_only)?;
    }
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| format!("Failed to open notebook: {}", e))
}

fn open_existing_notebook(path: &Path) -> Result<Connection, String> {
    if !path.is_file() {
        return Err(format!("Notebook not found: {}", path.display()));
    }
    let conn = Connection::open(path).map_err(|e| format!("Failed to open notebook: {}", e))?;
    ensure_db_schema(&conn).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn install_notebook(lock: NotebookLock, conn: Connection) -> Result<(), String> {
    let mut held = NOTEBOOK_LOCK.lock().map_err(|e| e.to_string())?;
    DB_CONNECTION
        .set(Mutex::new(conn))
        .map_err(|_| "Notebook is not open".to_string())?;
    *held = Some(lock);
    Ok(())
}

fn open_notebook_from_settings(settings: &AppSettings) -> Result<(), String> {
    let path = Path::new(&settings.database_path);
    if !path.is_file() {
        return Err(format!(
            "TreeNote could not find the remembered notebook:\n{}",
            settings.database_path
        ));
    }
    let lock = notebook_lock::try_acquire(path)?;
    let conn = open_existing_notebook(lock.notebook_path())?;
    install_notebook(lock, conn)?;
    {
        let mut stored = SETTINGS.lock().map_err(|e| e.to_string())?;
        *stored = settings.clone();
    }
    Ok(())
}

#[derive(Debug)]
pub(crate) struct PreparedNotebookSwitch {
    pub lock: NotebookLock,
    pub connection: Connection,
}

pub(crate) fn prepare_notebook_switch(
    current_lock: &NotebookLock,
    target: &Path,
) -> Result<PreparedNotebookSwitch, String> {
    let notebooks = current_notebooks_dir()?;
    let normalized = managed_notebook::require_managed_notebook(&notebooks, target)?;
    if current_lock.notebook_path() == normalized.as_path() {
        return Err("Notebook is already open".into());
    }
    let lock = notebook_lock::try_acquire(&normalized)?;
    let connection = open_notebook_for_recovery(lock.notebook_path())?;
    Ok(PreparedNotebookSwitch { lock, connection })
}

pub(crate) fn persist_switch_candidate(
    current_settings: &AppSettings,
    remembered_notebook_path: &Path,
    persist: impl FnOnce(&AppSettings) -> Result<(), String>,
) -> Result<AppSettings, String> {
    let mut candidate = current_settings.clone();
    candidate.database_path = remembered_notebook_path.to_string_lossy().to_string();
    persist(&candidate)?;
    Ok(candidate)
}

#[derive(Debug)]
pub enum StartupAction {
    Continue,
    RecoverNotebook {
        message: String,
        preserve_settings: Option<AppSettings>,
    },
}

fn recover_notebook_action(
    message: String,
    preserve_settings: Option<AppSettings>,
) -> StartupAction {
    StartupAction::RecoverNotebook {
        message,
        preserve_settings,
    }
}

fn install_and_remember(
    lock: NotebookLock,
    conn: Connection,
    settings: AppSettings,
    settings_file: &Path,
) -> Result<StartupAction, String> {
    install_notebook(lock, conn)?;
    save_settings_to_path(settings_file, &settings)?;
    {
        let mut stored = SETTINGS.lock().map_err(|e| e.to_string())?;
        *stored = settings;
    }
    Ok(StartupAction::Continue)
}

fn list_valid_managed_notebook_names(notebooks_dir: &Path) -> Result<Vec<String>, String> {
    if !notebooks_dir.exists() {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    let entries = match fs::read_dir(notebooks_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Ok(canonical) = managed_notebook::require_managed_notebook(notebooks_dir, &path) else {
            continue;
        };
        if probe_valid_treenote_notebook(&canonical).is_err() {
            continue;
        }
        if let Some(name) = canonical.file_name().and_then(|name| name.to_str()) {
            names.push(name.to_string());
        }
    }
    names.sort();
    Ok(names)
}

fn prepare_absent_settings(fs: &StartupFs) -> Result<StartupAction, String> {
    let notebooks = fs.notebooks_dir();
    let default_path = notebooks.join(DEFAULT_NOTEBOOK_FILENAME);
    let valid_names = list_valid_managed_notebook_names(&notebooks)?;
    let default_is_valid = valid_names
        .iter()
        .any(|name| managed_notebook::is_default_notebook_filename(name));
    if default_path.is_file() && !default_is_valid {
        return Ok(recover_notebook_action(
            format!(
                "TreeNote found a file at the default notebook location that is not a TreeNote notebook:\n{}",
                default_path.display()
            ),
            None,
        ));
    }
    if valid_names.is_empty() {
        fs::create_dir_all(&notebooks).map_err(|e| e.to_string())?;
        let settings = default_settings_on(&fs.data_root);
        let lock = notebook_lock::try_acquire(&default_path)?;
        let conn = open_or_create_notebook(lock.notebook_path())?;
        return install_and_remember(lock, conn, settings, &fs.settings_path());
    }
    if valid_names.len() == 1 && default_is_valid {
        let settings = default_settings_on(&fs.data_root);
        let lock = notebook_lock::try_acquire(&default_path)?;
        let conn = open_notebook_for_recovery(lock.notebook_path())?;
        return install_and_remember(lock, conn, settings, &fs.settings_path());
    }
    Ok(recover_notebook_action(
        "TreeNote could not decide which notebook to open. Create a new notebook or choose an existing one.".into(),
        None,
    ))
}

fn prepare_valid_settings(
    fs: &StartupFs,
    mut settings: AppSettings,
) -> Result<StartupAction, String> {
    settings = normalize_settings_on(settings, &fs.data_root);
    let notebooks = fs.notebooks_dir();
    let path = PathBuf::from(&settings.database_path);
    if !path.is_file() {
        return Ok(recover_notebook_action(
            format!(
                "TreeNote could not find the remembered notebook:\n{}",
                settings.database_path
            ),
            Some(settings),
        ));
    }
    if managed_notebook::require_managed_notebook(&notebooks, &path).is_err() {
        return Ok(recover_notebook_action(
            format!(
                "The remembered notebook is not in TreeNote's notebooks folder:\n{}",
                settings.database_path
            ),
            Some(settings),
        ));
    }
    if probe_valid_treenote_notebook(&path).is_err() {
        return Ok(recover_notebook_action(
            format!(
                "The remembered notebook is not a TreeNote notebook:\n{}",
                settings.database_path
            ),
            Some(settings),
        ));
    }
    open_notebook_from_settings(&settings)?;
    Ok(StartupAction::Continue)
}

fn prepare_startup_on(fs: &StartupFs) -> Result<StartupAction, String> {
    remember_data_root(fs.data_root.clone());
    match read_settings_file_at(&fs.settings_path()) {
        SettingsFileState::Absent => prepare_absent_settings(fs),
        SettingsFileState::Corrupt => Ok(recover_notebook_action(
            "TreeNote could not read its settings file.".into(),
            None,
        )),
        SettingsFileState::Valid(settings) => prepare_valid_settings(fs, settings),
    }
}

pub fn prepare_startup() -> Result<StartupAction, String> {
    prepare_startup_on(&production_startup_fs()?)
}

pub fn complete_notebook_recovery(
    selected_path: &Path,
    preserve_settings: Option<AppSettings>,
) -> Result<(), String> {
    let notebooks = current_notebooks_dir()?;
    let managed = managed_notebook::require_managed_notebook(&notebooks, selected_path)?;
    let prepared = prepare_recovery_locate(&managed)?;
    match persist_recovery_candidate(
        &managed,
        preserve_settings,
        persist_recovered_settings_to_disk,
    ) {
        Ok(settings) => commit_prepared_recovery(prepared, settings),
        Err(error) => {
            abandon_prepared_recovery(prepared);
            Err(error)
        }
    }
}

fn prepare_recovery_locate(path: &Path) -> Result<PreparedRecoveryNotebook, String> {
    if !path.is_file() {
        return Err("Selected notebook does not exist.".into());
    }
    let lock = notebook_lock::try_acquire(path)?;
    match open_notebook_for_recovery(lock.notebook_path()) {
        Ok(connection) => Ok(PreparedRecoveryNotebook {
            lock,
            connection,
            created_path: None,
        }),
        Err(error) => Err(error),
    }
}

fn create_notebook_file_exclusive(path: &Path) -> Result<(NotebookLock, Connection), String> {
    if path.exists() {
        return Err(
            "A notebook already exists with that name.".into(),
        );
    }
    let lock = notebook_lock::try_acquire(path)?;
    if lock.notebook_path().exists() {
        return Err(
            "A notebook already exists with that name.".into(),
        );
    }
    let created = lock.notebook_path().to_path_buf();
    match open_or_create_notebook(&created) {
        Ok(conn) => Ok((lock, conn)),
        Err(e) => {
            if created.is_file() {
                let _ = fs::remove_file(&created);
            }
            Err(e)
        }
    }
}

fn prepare_recovery_create(path: &Path) -> Result<PreparedRecoveryNotebook, String> {
    let (lock, connection) = create_notebook_file_exclusive(path)?;
    let created_path = lock.notebook_path().to_path_buf();
    Ok(PreparedRecoveryNotebook {
        lock,
        connection,
        created_path: Some(created_path),
    })
}

pub fn complete_notebook_creation(
    selected_path: &Path,
    preserve_settings: Option<AppSettings>,
) -> Result<(), String> {
    let notebooks = current_notebooks_dir()?;
    let dest = managed_notebook::require_new_managed_notebook_location(&notebooks, selected_path)?;
    if dest.exists() {
        return Err("A notebook already exists with that name.".into());
    }
    let prepared = prepare_recovery_create(&dest)?;
    match persist_recovery_candidate(
        prepared.lock.notebook_path(),
        preserve_settings,
        persist_recovered_settings_to_disk,
    ) {
        Ok(settings) => commit_prepared_recovery(prepared, settings),
        Err(error) => {
            abandon_prepared_recovery(prepared);
            Err(error)
        }
    }
}

pub fn list_notebooks() -> Result<Vec<String>, String> {
    list_valid_managed_notebook_names(&current_notebooks_dir()?)
}

pub fn create_notebook(name: String) -> Result<String, String> {
    let notebooks = current_notebooks_dir()?;
    let dest = managed_notebook::resolve_new_managed_notebook_path(&notebooks, &name)?;
    let filename = dest
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Notebook name is required.".to_string())?
        .to_string();
    let (lock, conn) = create_notebook_file_exclusive(&dest)?;
    drop(conn);
    drop(lock);
    Ok(filename)
}

pub fn resolve_import_destination(name: &str) -> Result<PathBuf, String> {
    let notebooks = current_notebooks_dir()?;
    let dest = managed_notebook::resolve_new_managed_notebook_path(&notebooks, name)?;
    if dest.exists() {
        return Err("A notebook already exists with that name.".into());
    }
    Ok(dest)
}

pub fn get_settings() -> Result<PublicSettings, String> {
    let s = SETTINGS.lock().map_err(|e| e.to_string())?;
    public_settings_from(s.clone())
}

pub fn update_settings(
    editor_font_family: String,
    minimize_to_tray: bool,
    backup_before_restore: bool,
) -> Result<PublicSettings, String> {
    let mut s = SETTINGS.lock().map_err(|e| e.to_string())?;
    s.editor_font_family = editor_font_family;
    s.minimize_to_tray = minimize_to_tray;
    s.backup_before_restore = backup_before_restore;
    save_settings_to_disk(&s)?;
    public_settings_from(s.clone())
}

pub fn minimize_to_tray_enabled() -> bool {
    SETTINGS
        .lock()
        .map(|s| s.minimize_to_tray)
        .unwrap_or(true)
}

pub fn switch_notebook(name: String) -> Result<PublicSettings, String> {
    let notebooks = current_notebooks_dir()?;
    let filename = managed_notebook::validate_notebook_name(&name)?;
    let dest = notebooks.join(filename);
    let normalized = managed_notebook::require_managed_notebook(&notebooks, &dest)?;

    {
        let held = NOTEBOOK_LOCK.lock().map_err(|e| e.to_string())?;
        if let Some(current) = held.as_ref() {
            if current.notebook_path() == normalized.as_path() {
                drop(held);
                return get_settings();
            }
        } else {
            return Err("Notebook is not open".into());
        }
    }

    let prepared = {
        let held = NOTEBOOK_LOCK.lock().map_err(|e| e.to_string())?;
        let current = held
            .as_ref()
            .ok_or_else(|| "Notebook is not open".to_string())?;
        prepare_notebook_switch(current, &normalized)?
    };

    let mut settings = SETTINGS.lock().map_err(|e| e.to_string())?;
    let mut db = db_connection()?;
    let mut held_lock = NOTEBOOK_LOCK.lock().map_err(|e| e.to_string())?;

    let candidate = persist_switch_candidate(&settings, prepared.lock.notebook_path(), |candidate| {
        save_settings_to_disk(candidate)
    })?;

    *db = prepared.connection;
    *held_lock = Some(prepared.lock);
    *settings = candidate;
    public_settings_from(settings.clone())
}

#[derive(Serialize)]
struct ExportNode {
    id: String,
    parent_id: Option<String>,
    label: String,
    content: String,
    sort_order: i64,
    is_expanded: Option<bool>,
    children: Vec<ExportNode>,
}
fn export_nodes(conn: &Connection, parent_id: Option<&str>) -> rusqlite::Result<Vec<ExportNode>> {
    let mut stmt = conn.prepare("SELECT id, parent_id, label, COALESCE(content,''), sort_order, is_expanded FROM notes WHERE parent_id IS ?1 ORDER BY sort_order ASC")?;
    let rows = stmt.query_map(params![parent_id], |row| {
        let id: String = row.get(0)?;
        Ok((
            id,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get::<_, Option<i64>>(5)?,
        ))
    })?;
    let mut out = Vec::new();
    for r in rows {
        let (id, parent_id, label, content, sort_order, expanded) = r?;
        let children = export_nodes(conn, Some(&id))?;
        out.push(ExportNode {
            id,
            parent_id,
            label,
            content,
            sort_order,
            is_expanded: expanded.map(|v| v == 1),
            children,
        });
    }
    Ok(out)
}

pub fn fetch_notebook_export_tree(
) -> Result<Vec<crate::convert::treenote_json::TreenoteJsonNode>, String> {
    let conn = db_connection()?;
    crate::convert::treenote_json::build_tree_from_connection(&conn)
}

pub fn notebook_counts() -> Result<NotebookCounts, String> {
    let conn = db_connection()?;
    let notes: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let trees: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM notes WHERE parent_id IS NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(NotebookCounts {
        notes: notes as usize,
        trees: trees as usize,
    })
}

#[derive(Debug, Serialize, Clone)]
pub struct NotebookCounts {
    pub notes: usize,
    pub trees: usize,
}

pub fn export_json(path: String) -> Result<String, String> {
    let conn = db_connection()?;
    let tree = export_nodes(&conn, None).map_err(|e| e.to_string())?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(
        &path,
        serde_json::to_string_pretty(&tree).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(path)
}

#[derive(Debug, Clone)]
pub struct NotebookNoteRow {
    pub id: String,
    pub parent_id: Option<String>,
    pub label: String,
    pub sort_order: i64,
    pub content: String,
}

pub fn fetch_all_notes_flat() -> Result<Vec<NotebookNoteRow>, String> {
    let conn = db_connection()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, parent_id, label, sort_order, COALESCE(content, '') \
             FROM notes ORDER BY COALESCE(parent_id, ''), sort_order, label",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(NotebookNoteRow {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                label: row.get(2)?,
                sort_order: row.get(3)?,
                content: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[derive(Debug, Serialize, Clone)]
pub struct ManagedBackupEntry {
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub locked: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct ManagedBackupList {
    pub entries: Vec<ManagedBackupEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_warning: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct RunBackupNowResult {
    pub path: String,
    pub metadata_saved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_warning: Option<String>,
}

pub type SnapshotProgressReporter = Box<dyn Fn(u32, u32) + Send>;

pub(crate) fn snapshot_progress_counts(pagecount: i32, remaining: i32) -> (u32, u32) {
    let total = pagecount.max(0) as u32;
    let done = total.saturating_sub(remaining.max(0) as u32);
    (done, total)
}

fn run_backup_snapshot_with_progress(
    dest: &Path,
    progress: Option<SnapshotProgressReporter>,
) -> Result<(), String> {
    let parent = dest
        .parent()
        .ok_or_else(|| "Invalid backup path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = parent.join(backup_snapshot_temp_filename());
    let snapshot_result = (|| {
        {
            let src = db_connection()?;
            let mut dest_conn = Connection::open(&tmp).map_err(|e| e.to_string())?;
            let backup = Backup::new(&src, &mut dest_conn).map_err(|e| e.to_string())?;
            let pages_per_step = 5;
            let pause = Duration::from_millis(250);
            loop {
                match backup.step(pages_per_step).map_err(|e| e.to_string())? {
                    StepResult::Done => {
                        if let Some(ref report) = progress {
                            let p = backup.progress();
                            let (_, total) = snapshot_progress_counts(p.pagecount, p.remaining);
                            report(total, total);
                        }
                        break;
                    }
                    StepResult::More => {
                        if let Some(ref report) = progress {
                            let p = backup.progress();
                            let (done, total) =
                                snapshot_progress_counts(p.pagecount, p.remaining);
                            report(done, total);
                        }
                    }
                    StepResult::Busy | StepResult::Locked => {
                        thread::sleep(pause);
                    }
                    _ => {
                        thread::sleep(pause);
                    }
                }
            }
        }
        validate_sqlite_integrity(&tmp)?;
        promote_backup_no_clobber(&tmp, dest)?;
        Ok::<(), String>(())
    })();
    if snapshot_result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    snapshot_result
}

fn snapshot_live_notebook_to_path(dest: &Path) -> Result<(), String> {
    run_backup_snapshot_with_progress(dest, None)
}

fn snapshot_live_notebook_to_path_with_progress(
    dest: &Path,
    progress: SnapshotProgressReporter,
) -> Result<(), String> {
    run_backup_snapshot_with_progress(dest, Some(progress))
}

fn existing_backup_timestamps(dir: &Path) -> Result<std::collections::HashSet<u64>, String> {
    Ok(list_managed_backup_timestamps(dir)?.into_iter().collect())
}

fn finalize_backup_prune_and_metadata(
    notebook_dir: &Path,
    timestamp: u64,
    label: Option<String>,
    locked: bool,
) -> Result<(RunBackupNowResult, Option<String>), String> {
    let read = read_index(notebook_dir);
    let metadata_warning = metadata_warning(read.clone());
    let lock_state = backup_meta::lock_state_from_read(read.clone());
    let prune_outcome = prune_managed_backups(notebook_dir, timestamp, lock_state)?;
    if let PruneOutcome::Suspended { reason } = prune_outcome {
        eprintln!("TreeNote backup pruning suspended: {reason}");
    }
    let existing = existing_backup_timestamps(notebook_dir)?;
    let mut metadata_saved = true;
    let mut metadata_warning_result = metadata_warning.clone();
    if matches!(read, IndexReadResult::Ok(_)) {
        if let Err(reason) = forget_missing(notebook_dir, &existing) {
            metadata_saved = false;
            metadata_warning_result = Some(format!(
                "Backup was created, but backup metadata could not be updated: {reason}"
            ));
        }
    }
    let dest = notebook_dir.join(backup_filename_for_timestamp(timestamp));
    if label.is_some() || locked {
        if let Err(reason) = set_entry(notebook_dir, timestamp, label, locked) {
            metadata_saved = false;
            metadata_warning_result = Some(format!(
                "Backup was created, but its label or lock could not be saved: {reason}"
            ));
        }
    }
    Ok((
        RunBackupNowResult {
            path: dest.to_string_lossy().to_string(),
            metadata_saved,
            metadata_warning: metadata_warning_result,
        },
        metadata_warning,
    ))
}

fn create_managed_backup_without_prune(
    settings: &AppSettings,
    progress: Option<SnapshotProgressReporter>,
) -> Result<(PathBuf, u64), String> {
    let src = PathBuf::from(&settings.database_path);
    if !src.exists() {
        return Err("Active database does not exist yet".into());
    }
    let notebook_dir = {
        let backup_root = current_backups_dir()?;
        managed_notebook_dir(&path_to_setting(&backup_root), &settings.database_path)
    };
    fs::create_dir_all(&notebook_dir).map_err(|e| e.to_string())?;
    let (dest, timestamp) = reserve_unique_backup_dest(&notebook_dir)?;
    match progress {
        Some(reporter) => snapshot_live_notebook_to_path_with_progress(&dest, reporter)?,
        None => snapshot_live_notebook_to_path(&dest)?,
    };
    Ok((notebook_dir, timestamp))
}

pub fn run_backup_now(
    label: Option<String>,
    locked: bool,
    progress: Option<SnapshotProgressReporter>,
) -> Result<RunBackupNowResult, String> {
    let s = SETTINGS.lock().map_err(|e| e.to_string())?;
    let trimmed_label = label.and_then(|value| {
        let t = value.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    let (notebook_dir, timestamp) = create_managed_backup_without_prune(&s, progress)?;
    let (result, _) = finalize_backup_prune_and_metadata(
        &notebook_dir,
        timestamp,
        trimmed_label,
        locked,
    )?;
    Ok(result)
}

pub fn run_scheduled_backup_if_due() -> Result<Option<RunBackupNowResult>, String> {
    let s = SETTINGS.lock().map_err(|e| e.to_string())?;
    let backup_root = current_backups_dir()?;
    let notebook_dir = managed_notebook_dir(&path_to_setting(&backup_root), &s.database_path);
    let now = backup_now_secs();
    if is_backup_due(&notebook_dir, now)? {
        drop(s);
        run_backup_now(None, false, None).map(Some)
    } else {
        Ok(None)
    }
}

pub fn list_managed_backups() -> Result<ManagedBackupList, String> {
    let s = SETTINGS.lock().map_err(|e| e.to_string())?;
    let backup_root = current_backups_dir()?;
    let notebook_dir = managed_notebook_dir(&path_to_setting(&backup_root), &s.database_path);
    let read = read_index(&notebook_dir);
    let warning = metadata_warning(read.clone());
    let mut timestamps = list_managed_backup_timestamps(&notebook_dir)?;
    timestamps.sort_by(|a, b| b.cmp(a));
    Ok(ManagedBackupList {
        entries: timestamps
            .into_iter()
            .map(|timestamp| {
                let meta = meta_for_timestamp(&read, timestamp);
                ManagedBackupEntry {
                    timestamp,
                    label: meta.label,
                    locked: meta.locked,
                }
            })
            .collect(),
        metadata_warning: warning,
    })
}

pub fn set_backup_lock(timestamp: u64, locked: bool) -> Result<ManagedBackupList, String> {
    let s = SETTINGS.lock().map_err(|e| e.to_string())?;
    let backup_root = current_backups_dir()?;
    let notebook_dir = managed_notebook_dir(&path_to_setting(&backup_root), &s.database_path);
    let backup_path = notebook_dir.join(backup_filename_for_timestamp(timestamp));
    if !backup_path.is_file() {
        return Err("Selected backup is no longer available".into());
    }
    set_lock(&notebook_dir, timestamp, locked)?;
    list_managed_backups()
}

fn reserve_unique_backup_dest(notebook_dir: &Path) -> Result<(PathBuf, u64), String> {
    let mut timestamp = backup_now_secs();
    let start = timestamp;
    loop {
        let dest = notebook_dir.join(backup_filename_for_timestamp(timestamp));
        if !dest.exists() {
            return Ok((dest, timestamp));
        }
        timestamp = timestamp.saturating_add(1);
        if timestamp > start.saturating_add(3600) {
            return Err("Could not reserve a backup filename".into());
        }
    }
}

fn validate_sqlite_integrity(path: &Path) -> Result<(), String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Failed to open backup: {}", e))?;
    let result: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if result != "ok" {
        return Err("Backup integrity check failed".into());
    }
    Ok(())
}

fn promote_backup_no_clobber(tmp: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        return Err("Backup destination already exists".into());
    }
    fs::rename(tmp, dest).map_err(|e| e.to_string())
}

fn notes_table_exists(conn: &Connection) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            params![NOTES_TABLE],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(count > 0)
}

fn notes_column_names(conn: &Connection, table: &str) -> Result<Vec<String>, String> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(names)
}

fn validate_backup_notes_schema(conn: &Connection) -> Result<(), String> {
    if !notes_table_exists(conn)? {
        return Err("Backup does not contain a notes table".into());
    }
    let columns = notes_column_names(conn, NOTES_TABLE)?;
    for required in NOTES_COLUMNS {
        if !columns.iter().any(|c| c == required) {
            return Err(format!(
                "Backup is missing required notes column: {}",
                required
            ));
        }
    }
    Ok(())
}

fn restore_notes_from_backup(live: &Connection, backup_path: &Path) -> Result<(), String> {
    let backup_path_str = backup_path
        .to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "''");
    let attach_sql = format!("ATTACH DATABASE '{backup_path_str}' AS {RESTORE_ATTACH_ALIAS}");
    live.execute_batch(&attach_sql)
        .map_err(|e| format!("Failed to attach backup: {}", e))?;

    let column_list = NOTES_COLUMNS.join(", ");
    let insert_sql = format!(
        "INSERT INTO {NOTES_TABLE} ({column_list}) \
         SELECT {column_list} FROM {RESTORE_ATTACH_ALIAS}.{NOTES_TABLE}"
    );

    let result = (|| {
        live.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        live.execute(&format!("DELETE FROM {NOTES_TABLE}"), [])
            .map_err(|e| e.to_string())?;
        live.execute_batch(&insert_sql).map_err(|e| e.to_string())?;
        live.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })();

    if result.is_err() {
        let _ = live.execute_batch("ROLLBACK");
    }

    let detach_sql = format!("DETACH DATABASE {RESTORE_ATTACH_ALIAS}");
    let _ = live.execute_batch(&detach_sql);

    result
}

pub(crate) fn restore_notes_from_backup_path(
    live: &Connection,
    backup_path: &Path,
) -> Result<(), String> {
    let backup =
        Connection::open_with_flags(backup_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("Failed to open backup: {}", e))?;
    validate_backup_notes_schema(&backup)?;
    restore_notes_from_backup(live, backup_path)
}

pub type BackupPhaseReporter = Box<dyn Fn(&str) + Send>;

pub fn restore_notebook_from_backup(
    timestamp: u64,
    create_backup_first: Option<bool>,
    snapshot_progress: Option<SnapshotProgressReporter>,
    phase: Option<BackupPhaseReporter>,
) -> Result<(), String> {
    let settings = SETTINGS.lock().map_err(|e| e.to_string())?;
    let should_backup_first = create_backup_first.unwrap_or(settings.backup_before_restore);
    let notebook_dir = {
        let backup_root = current_backups_dir()?;
        managed_notebook_dir(&path_to_setting(&backup_root), &settings.database_path)
    };
    let backup_path = notebook_dir.join(backup_filename_for_timestamp(timestamp));
    if !backup_path.is_file() {
        return Err("Selected backup is no longer available".into());
    }

    {
        let backup =
            Connection::open_with_flags(&backup_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|e| format!("Failed to open backup: {}", e))?;
        validate_backup_notes_schema(&backup)?;
    }

    let prune_reference_timestamp = if should_backup_first {
        let (_, safety_timestamp) =
            create_managed_backup_without_prune(&settings, snapshot_progress)?;
        safety_timestamp
    } else {
        backup_now_secs()
    };

    if let Some(ref report_phase) = phase {
        report_phase("restore");
    }

    {
        let conn = db_connection()?;
        restore_notes_from_backup_path(&conn, &backup_path)?;
    }

    let read = read_index(&notebook_dir);
    let lock_state = backup_meta::lock_state_from_read(read.clone());
    let prune_outcome = prune_managed_backups(&notebook_dir, prune_reference_timestamp, lock_state)?;
    if let PruneOutcome::Suspended { reason } = prune_outcome {
        eprintln!("TreeNote backup pruning suspended: {reason}");
    }
    if matches!(read, IndexReadResult::Ok(_)) {
        let existing = existing_backup_timestamps(&notebook_dir)?;
        forget_missing(&notebook_dir, &existing)?;
    }

    if let Some(report_phase) = phase {
        report_phase("finished");
    }
    Ok(())
}

pub fn security_status() -> Result<SecurityStatus, String> {
    let s = SETTINGS.lock().map_err(|e| e.to_string())?;
    Ok(SecurityStatus {
        password_configured: s.password_hash.is_some(),
    })
}
pub fn verify_password(password: String) -> Result<bool, String> {
    let s = SETTINGS.lock().map_err(|e| e.to_string())?;
    match &s.password_hash {
        Some(hash) => verify_password_hash(&password, hash),
        None => Ok(true),
    }
}
pub fn set_password(current_password: Option<String>, new_password: String) -> Result<(), String> {
    if new_password.len() < 4 {
        return Err("Password must be at least 4 characters".into());
    }
    if !verify_password(current_password.unwrap_or_default())? {
        return Err("Current password is incorrect".into());
    }
    let hash = new_password_hash(&new_password)?;
    let mut s = SETTINGS.lock().map_err(|e| e.to_string())?;
    s.password_hash = Some(hash);
    save_settings_to_disk(&s)
}
pub fn remove_password(current_password: String) -> Result<(), String> {
    if !verify_password(current_password)? {
        return Err("Current password is incorrect".into());
    }
    let mut s = SETTINGS.lock().map_err(|e| e.to_string())?;
    s.password_hash = None;
    save_settings_to_disk(&s)
}

pub fn fetch_tree_from_db() -> Result<Vec<TreeNode>, String> {
    let conn = db_connection()?;
    fetch_nodes_recursive(&conn, None).map_err(|e| e.to_string())
}
fn fetch_nodes_recursive(
    conn: &Connection,
    parent_id: Option<&str>,
) -> rusqlite::Result<Vec<TreeNode>> {
    let mut stmt = conn.prepare("SELECT id, label, is_expanded, content FROM notes WHERE parent_id IS ?1 ORDER BY sort_order ASC")?;
    let iter = stmt.query_map(params![parent_id], |row| {
        let id: String = row.get(0)?;
        let children = fetch_nodes_recursive(conn, Some(&id))?;
        Ok(TreeNode {
            id,
            label: row.get(1)?,
            is_expanded: row.get::<_, Option<i64>>(2)?.map(|v| v == 1),
            children: if children.is_empty() {
                None
            } else {
                Some(children)
            },
            is_draggable: None,
            content: row.get(3)?,
        })
    })?;
    iter.collect()
}

const MAX_TREE_LEVEL: i64 = 20;

fn depth_limit_add_message() -> String {
    format!(
        "Notes can be nested up to {} levels. This note is already at the limit, so a child cannot be added here.",
        MAX_TREE_LEVEL
    )
}

fn depth_limit_move_message() -> String {
    format!(
        "Notes can be nested up to {} levels. Moving this branch here would nest it too deeply.",
        MAX_TREE_LEVEL
    )
}

fn note_level(conn: &Connection, id: &str) -> Result<i64, String> {
    conn.query_row(
        "WITH RECURSIVE walk(id, depth) AS (
            SELECT id, 1 FROM notes WHERE id = ?1
            UNION ALL
            SELECT notes.parent_id, walk.depth + 1
            FROM walk
            JOIN notes ON notes.id = walk.id
            WHERE notes.parent_id IS NOT NULL
        )
        SELECT COALESCE(MAX(depth), 0) FROM walk",
        params![id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

fn subtree_depth(conn: &Connection, id: &str) -> Result<i64, String> {
    conn.query_row(
        "WITH RECURSIVE walk(id, depth) AS (
            SELECT id, 1 FROM notes WHERE id = ?1
            UNION ALL
            SELECT notes.id, walk.depth + 1
            FROM notes
            JOIN walk ON notes.parent_id = walk.id
        )
        SELECT COALESCE(MAX(depth), 0) FROM walk",
        params![id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

fn would_exceed_max_level(
    conn: &Connection,
    node_id: &str,
    new_parent_id: Option<&str>,
) -> Result<bool, String> {
    let parent_level = match new_parent_id {
        Some(parent_id) => note_level(conn, parent_id)?,
        None => 0,
    };
    let depth = subtree_depth(conn, node_id)?;
    let resulting = parent_level + depth;
    if resulting <= MAX_TREE_LEVEL {
        return Ok(false);
    }
    let current_max = note_level(conn, node_id)? + depth - 1;
    Ok(resulting > current_max)
}

pub fn add_node(parent_id: Option<String>, label: String) -> Result<TreeNode, String> {
    let mut conn = db_connection()?;
    add_node_in_conn(&mut conn, parent_id, label)
}

fn add_node_in_conn(
    conn: &mut Connection,
    parent_id: Option<String>,
    label: String,
) -> Result<TreeNode, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if let Some(ref parent) = parent_id {
        let parent_level = note_level(&tx, parent)?;
        if parent_level >= MAX_TREE_LEVEL {
            return Err(depth_limit_add_message());
        }
    }
    let id = Uuid::new_v4().to_string();
    tx.execute(
        "UPDATE notes SET sort_order = sort_order + 1 WHERE parent_id IS ?1",
        params![parent_id.as_ref()],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO notes (id,parent_id,label,is_expanded,sort_order,content) VALUES (?1,?2,?3,1,0,'')",
        params![id, parent_id, label],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(TreeNode {
        id,
        label,
        is_expanded: Some(true),
        children: None,
        is_draggable: None,
        content: Some(String::new()),
    })
}
pub fn update_node(id: String, new_label: String) -> Result<(), String> {
    db_connection()?
        .execute(
            "UPDATE notes SET label=?1 WHERE id=?2",
            params![new_label, id],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn delete_node(id: String) -> Result<(), String> {
    let mut conn = db_connection()?;
    delete_node_in_conn(&mut conn, &id).map_err(|e| e.to_string())
}

fn delete_node_in_conn(conn: &mut Connection, id: &str) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    let deleted = tx.execute(
        "WITH RECURSIVE descendants(id) AS (
            SELECT id FROM notes WHERE id=?1
            UNION
            SELECT notes.id
            FROM notes
            JOIN descendants ON notes.parent_id=descendants.id
        )
        DELETE FROM notes WHERE id IN (SELECT id FROM descendants)",
        params![id],
    )?;
    if deleted == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    tx.commit()?;
    Ok(())
}
pub fn move_node(
    id: String,
    new_parent_id: Option<String>,
    new_sort_order: i64,
) -> Result<(), String> {
    let mut conn = db_connection()?;
    move_node_in_conn(&mut conn, id, new_parent_id, new_sort_order)
}

fn move_node_in_conn(
    conn: &mut Connection,
    id: String,
    new_parent_id: Option<String>,
    new_sort_order: i64,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (old_parent_id, old_sort_order): (Option<String>, i64) = tx
        .query_row(
            "SELECT parent_id, sort_order FROM notes WHERE id=?1",
            params![id.clone()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;

    if let Some(ref parent_id) = new_parent_id {
        if old_parent_id != new_parent_id {
            let would_cycle: i64 = tx
                .query_row(
                    "WITH RECURSIVE descendants(id) AS (
                        SELECT id FROM notes WHERE id=?1
                        UNION
                        SELECT notes.id
                        FROM notes
                        JOIN descendants ON notes.parent_id=descendants.id
                    )
                    SELECT COUNT(*) FROM descendants WHERE id=?2",
                    params![id, parent_id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if would_cycle > 0 {
                return Err(
                    "Cannot move a note under itself or one of its descendants".into(),
                );
            }
            if would_exceed_max_level(&tx, &id, Some(parent_id))? {
                return Err(depth_limit_move_message());
            }
        }
    } else if old_parent_id != new_parent_id
        && would_exceed_max_level(&tx, &id, None)?
    {
        return Err(depth_limit_move_message());
    }

    if old_parent_id == new_parent_id {
        if old_sort_order < new_sort_order {
            tx.execute(
                "UPDATE notes SET sort_order = sort_order - 1 \
                 WHERE parent_id IS ?1 AND sort_order > ?2 AND sort_order <= ?3 AND id != ?4",
                params![new_parent_id.as_ref(), old_sort_order, new_sort_order, id],
            )
            .map_err(|e| e.to_string())?;
        } else if old_sort_order > new_sort_order {
            tx.execute(
                "UPDATE notes SET sort_order = sort_order + 1 \
                 WHERE parent_id IS ?1 AND sort_order >= ?2 AND sort_order < ?3 AND id != ?4",
                params![new_parent_id.as_ref(), new_sort_order, old_sort_order, id],
            )
            .map_err(|e| e.to_string())?;
        }

        tx.execute(
            "UPDATE notes SET sort_order = ?1 WHERE id = ?2",
            params![new_sort_order, id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        tx.execute(
            "UPDATE notes SET sort_order=sort_order-1 WHERE parent_id IS ?1 AND sort_order>?2",
            params![old_parent_id.as_ref(), old_sort_order],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE notes SET sort_order=sort_order+1 WHERE parent_id IS ?1 AND sort_order>=?2",
            params![new_parent_id.as_ref(), new_sort_order],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE notes SET parent_id=?1, sort_order=?2 WHERE id=?3",
            params![new_parent_id, new_sort_order, id],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())
}
pub fn get_node_content(id: String) -> Result<String, String> {
    let conn = db_connection()?;
    conn.query_row(
        "SELECT COALESCE(content,'') FROM notes WHERE id=?1",
        params![id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
pub fn get_node(id: String) -> Result<TreeNode, String> {
    let conn = db_connection()?;
    conn.query_row(
        "SELECT id,label,is_expanded,content FROM notes WHERE id=?1",
        params![id],
        |r| {
            Ok(TreeNode {
                id: r.get(0)?,
                label: r.get(1)?,
                is_expanded: r.get::<_, Option<i64>>(2)?.map(|v| v == 1),
                children: None,
                is_draggable: None,
                content: r.get(3)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}
pub fn update_node_content(id: String, content: String) -> Result<(), String> {
    let changed = db_connection()?
        .execute(
            "UPDATE notes SET content=?1 WHERE id=?2",
            params![content, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Note not found".into());
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct SubtreeNodeRow {
    id: String,
    parent_id: Option<String>,
    label: String,
    content: String,
    sort_order: i64,
    is_expanded: Option<i64>,
}

fn collect_subtree_rows(conn: &Connection, root_id: &str) -> rusqlite::Result<Vec<SubtreeNodeRow>> {
    let mut rows = Vec::new();
    collect_subtree_rows_dfs(conn, root_id, &mut rows)?;
    Ok(rows)
}

fn collect_subtree_rows_dfs(
    conn: &Connection,
    id: &str,
    out: &mut Vec<SubtreeNodeRow>,
) -> rusqlite::Result<()> {
    let row = conn.query_row(
        "SELECT id, parent_id, label, COALESCE(content,''), sort_order, is_expanded FROM notes WHERE id=?1",
        params![id],
        |r| {
            Ok(SubtreeNodeRow {
                id: r.get(0)?,
                parent_id: r.get(1)?,
                label: r.get(2)?,
                content: r.get(3)?,
                sort_order: r.get(4)?,
                is_expanded: r.get(5)?,
            })
        },
    )?;
    out.push(row);

    let child_ids: Vec<String> = conn
        .prepare("SELECT id FROM notes WHERE parent_id=?1 ORDER BY sort_order ASC")?
        .query_map(params![id], |r| r.get(0))?
        .filter_map(Result::ok)
        .collect();
    for child_id in child_ids {
        collect_subtree_rows_dfs(conn, &child_id, out)?;
    }
    Ok(())
}

pub fn duplicate_node(id: String) -> Result<TreeNode, String> {
    let mut conn = db_connection()?;
    duplicate_node_in_conn(&mut conn, &id).map_err(|e| e.to_string())
}

fn duplicate_node_in_conn(conn: &mut Connection, id: &str) -> rusqlite::Result<TreeNode> {
    let tx = conn.transaction()?;
    let subtree = collect_subtree_rows(&tx, id)?;
    if subtree.is_empty() {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    let source = &subtree[0];

    let mut id_map = std::collections::HashMap::new();
    for row in &subtree {
        id_map.insert(row.id.clone(), Uuid::new_v4().to_string());
    }

    let new_root_id = id_map[&source.id].clone();
    let new_root_sort_order = source.sort_order + 1;

    tx.execute(
        "UPDATE notes SET sort_order = sort_order + 1 \
         WHERE parent_id IS ?1 AND sort_order > ?2",
        params![source.parent_id.as_ref(), source.sort_order],
    )?;

    for row in &subtree {
        let new_id = id_map[&row.id].clone();
        let new_parent_id = if row.id == source.id {
            source.parent_id.clone()
        } else {
            row.parent_id.as_ref().map(|parent| id_map[parent].clone())
        };
        let mut new_label = row.label.clone();
        if row.id == source.id {
            new_label = format!("Copy of {}", new_label);
        }
        let new_sort_order = if row.id == source.id {
            new_root_sort_order
        } else {
            row.sort_order
        };
        tx.execute(
            "INSERT INTO notes (id, parent_id, label, is_expanded, sort_order, content) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                new_id,
                new_parent_id,
                new_label,
                row.is_expanded,
                new_sort_order,
                row.content
            ],
        )?;
    }

    tx.commit()?;

    Ok(TreeNode {
        id: new_root_id,
        label: format!("Copy of {}", source.label),
        is_expanded: source.is_expanded.map(|v| v == 1),
        children: None,
        is_draggable: None,
        content: Some(source.content.clone()),
    })
}

fn export_single_branch(conn: &Connection, id: &str) -> rusqlite::Result<ExportNode> {
    let (node_id, parent_id, label, content, sort_order, expanded): (
        String,
        Option<String>,
        String,
        String,
        i64,
        Option<i64>,
    ) = conn.query_row(
        "SELECT id, parent_id, label, COALESCE(content,''), sort_order, is_expanded FROM notes WHERE id=?1",
        params![id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        },
    )?;
    let children = export_nodes(conn, Some(id))?;
    Ok(ExportNode {
        id: node_id,
        parent_id,
        label,
        content,
        sort_order,
        is_expanded: expanded.map(|v| v == 1),
        children,
    })
}

fn write_branch_export(conn: &Connection, id: &str, path: &str) -> Result<String, String> {
    let branch = export_single_branch(conn, id).map_err(|e| e.to_string())?;
    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(
        path,
        serde_json::to_string_pretty(&vec![branch]).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(path.to_string())
}

pub fn export_branch(id: String, path: String) -> Result<String, String> {
    let conn = db_connection()?;
    write_branch_export(&conn, &id, &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(CREATE_NOTES_TABLE_SQL)
            .expect("create schema");
        conn
    }

    fn insert_test_node(
        conn: &Connection,
        id: &str,
        parent_id: Option<&str>,
        label: &str,
        sort_order: i64,
        content: &str,
    ) {
        conn.execute(
            "INSERT INTO notes (id, parent_id, label, is_expanded, sort_order, content) VALUES (?1, ?2, ?3, 1, ?4, ?5)",
            params![id, parent_id, label, sort_order, content],
        )
        .expect("insert node");
    }

    #[test]
    fn stale_location_fields_are_ignored_when_parsing_settings() {
        let json = r#"{
            "database_path": "C:/data/test.sqlite3",
            "notebook_root": "C:/old/root",
            "backup_folder": "C:/data/backups",
            "export_folder": "C:/data/exports",
            "backup_interval_hours": 24,
            "backup_retention": 7,
            "last_backup_at": null,
            "password_hash": null,
            "editor_font_family": "system"
        }"#;
        let parsed: AppSettings = serde_json::from_str(json).expect("parse settings");
        assert_eq!(parsed.database_path, "C:/data/test.sqlite3");
        assert_eq!(parsed.backup_interval_hours, 24);
        assert_eq!(parsed.backup_retention, 7);
    }

    #[test]
    fn legacy_settings_with_interval_and_retention_still_parse() {
        let json = r#"{
            "database_path": "C:/data/test.sqlite3",
            "backup_folder": "C:/data/backups",
            "backup_interval_hours": 24,
            "backup_retention": 7,
            "last_backup_at": null,
            "password_hash": null,
            "editor_font_family": "system"
        }"#;
        let parsed: AppSettings = serde_json::from_str(json).expect("parse settings");
        assert_eq!(parsed.backup_interval_hours, 24);
        assert_eq!(parsed.backup_retention, 7);
    }

    #[test]
    fn scheduled_backup_due_uses_ten_minute_policy_not_persisted_interval() {
        use crate::backup::{
            backup_filename_for_timestamp, is_backup_due, managed_notebook_dir,
            BACKUP_INTERVAL_SECS,
        };
        let dir = std::env::temp_dir().join(format!("treenote-due-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp dir");
        let notebook_dir = managed_notebook_dir(dir.to_str().unwrap(), "C:/notes/test.sqlite3");
        fs::create_dir_all(&notebook_dir).expect("notebook dir");
        let now = 1_700_000_000u64;
        let recent = now - BACKUP_INTERVAL_SECS + 60;
        let name = backup_filename_for_timestamp(recent);
        fs::write(notebook_dir.join(name), "backup").expect("write backup");
        assert!(!is_backup_due(&notebook_dir, now).expect("due check"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_branch_export_writes_to_explicit_path() {
        let conn = setup_test_conn();
        insert_test_node(&conn, "root", None, "Root", 0, "root");
        insert_test_node(&conn, "branch", Some("root"), "Branch", 0, "branch");
        insert_test_node(&conn, "leaf", Some("branch"), "Leaf", 0, "leaf");

        let dir = std::env::temp_dir().join(format!("treenote-export-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("Branch.json");
        let saved =
            write_branch_export(&conn, "branch", path.to_str().unwrap()).expect("write export");
        assert_eq!(saved, path.to_string_lossy());
        let contents = fs::read_to_string(&path).expect("read export");
        assert!(contents.contains("\"label\": \"Branch\""));
        assert!(contents.contains("\"label\": \"Leaf\""));
        assert!(!contents.contains("\"label\": \"Root\""));
        assert!(!contents.contains("\"label\": \"Other\""));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicate_node_creates_adjacent_sibling_with_descendants() {
        let mut conn = setup_test_conn();
        insert_test_node(&conn, "root", None, "Root", 0, "root content");
        insert_test_node(&conn, "child", Some("root"), "Child", 0, "child content");
        insert_test_node(&conn, "grand", Some("child"), "Grand", 0, "grand content");

        let duplicated = duplicate_node_in_conn(&mut conn, "child").expect("duplicate");
        assert_eq!(duplicated.label, "Copy of Child");

        let siblings: Vec<(String, i64)> = conn
            .prepare("SELECT label, sort_order FROM notes WHERE parent_id='root' ORDER BY sort_order ASC")
            .expect("prepare")
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .expect("query")
            .filter_map(Result::ok)
            .collect();
        assert_eq!(siblings.len(), 2);
        assert_eq!(siblings[0].0, "Child");
        assert_eq!(siblings[1].0, "Copy of Child");

        let grand_children: Vec<String> = conn
            .prepare(
                "SELECT label FROM notes WHERE parent_id IN \
                 (SELECT id FROM notes WHERE label='Copy of Child')",
            )
            .expect("prepare")
            .query_map([], |r| r.get(0))
            .expect("query")
            .filter_map(Result::ok)
            .collect();
        assert_eq!(grand_children, vec!["Grand".to_string()]);
    }

    #[test]
    fn duplicate_node_rolls_back_on_partial_failure() {
        let mut conn = setup_test_conn();
        insert_test_node(&conn, "root", None, "Root", 0, "root content");
        insert_test_node(&conn, "child", Some("root"), "Child", 0, "child content");
        insert_test_node(&conn, "grand", Some("child"), "Grand", 0, "grand content");
        insert_test_node(&conn, "sibling", Some("root"), "Sibling", 1, "sibling content");
        conn.execute(
            "CREATE UNIQUE INDEX notes_label_unique ON notes(label)",
            [],
        )
        .expect("unique index");

        let err = duplicate_node_in_conn(&mut conn, "child").expect_err("duplicate fails");
        assert!(err.to_string().contains("UNIQUE"));

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 4);

        let copy_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE label LIKE 'Copy of %'",
                [],
                |r| r.get(0),
            )
            .expect("copy count");
        assert_eq!(copy_count, 0);

        let siblings: Vec<(String, i64)> = conn
            .prepare("SELECT label, sort_order FROM notes WHERE parent_id='root' ORDER BY sort_order ASC")
            .expect("prepare")
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .expect("query")
            .filter_map(Result::ok)
            .collect();
        assert_eq!(
            siblings,
            vec![
                ("Child".to_string(), 0),
                ("Sibling".to_string(), 1),
            ]
        );
    }

    fn setup_move_test_tree(conn: &Connection) {
        insert_test_node(conn, "root", None, "Root", 0, "root");
        insert_test_node(conn, "a", Some("root"), "A", 0, "a");
        insert_test_node(conn, "a1", Some("a"), "A1", 0, "a1");
        insert_test_node(conn, "b", Some("root"), "B", 1, "b");
    }

    #[test]
    fn move_node_rejects_self_parent() {
        let mut conn = setup_test_conn();
        setup_move_test_tree(&conn);

        let err = move_node_in_conn(&mut conn, "a".into(), Some("a".into()), 0)
            .expect_err("self parent");
        assert!(err.contains("Cannot move a note under itself or one of its descendants"));

        let parent: Option<String> = conn
            .query_row("SELECT parent_id FROM notes WHERE id='a'", [], |r| r.get(0))
            .expect("parent");
        assert_eq!(parent, Some("root".to_string()));
    }

    #[test]
    fn move_node_rejects_descendant_parent() {
        let mut conn = setup_test_conn();
        setup_move_test_tree(&conn);

        let err = move_node_in_conn(&mut conn, "a".into(), Some("a1".into()), 0)
            .expect_err("descendant parent");
        assert!(err.contains("Cannot move a note under itself or one of its descendants"));

        let parent: Option<String> = conn
            .query_row("SELECT parent_id FROM notes WHERE id='a'", [], |r| r.get(0))
            .expect("parent");
        assert_eq!(parent, Some("root".to_string()));
    }

    #[test]
    fn move_node_allows_valid_reparent() {
        let mut conn = setup_test_conn();
        setup_move_test_tree(&conn);

        move_node_in_conn(&mut conn, "a".into(), Some("b".into()), 0)
            .expect("valid reparent");

        let parent: Option<String> = conn
            .query_row("SELECT parent_id FROM notes WHERE id='a'", [], |r| r.get(0))
            .expect("a parent");
        assert_eq!(parent, Some("b".to_string()));

        let a1_parent: Option<String> = conn
            .query_row("SELECT parent_id FROM notes WHERE id='a1'", [], |r| r.get(0))
            .expect("a1 parent");
        assert_eq!(a1_parent, Some("a".to_string()));
    }

    #[test]
    fn move_node_allows_sibling_reorder() {
        let mut conn = setup_test_conn();
        setup_move_test_tree(&conn);

        move_node_in_conn(&mut conn, "b".into(), Some("root".into()), 0)
            .expect("sibling reorder");

        let siblings: Vec<(String, i64)> = conn
            .prepare("SELECT id, sort_order FROM notes WHERE parent_id='root' ORDER BY sort_order ASC")
            .expect("prepare")
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get(1)?)))
            .expect("query")
            .filter_map(Result::ok)
            .collect();
        assert_eq!(siblings, vec![("b".to_string(), 0), ("a".to_string(), 1)]);
    }

    fn ordered_siblings(conn: &Connection, parent_id: Option<&str>) -> Vec<(String, i64)> {
        conn.prepare(
            "SELECT id, sort_order FROM notes WHERE parent_id IS ?1 ORDER BY sort_order ASC",
        )
        .expect("prepare")
        .query_map(params![parent_id], |r| Ok((r.get::<_, String>(0)?, r.get(1)?)))
        .expect("query")
        .filter_map(Result::ok)
        .collect()
    }

    #[test]
    fn move_node_insert_before_same_parent_moving_down() {
        let mut conn = setup_test_conn();
        insert_test_node(&conn, "root", None, "Root", 0, "");
        insert_test_node(&conn, "n0", Some("root"), "N0", 0, "");
        insert_test_node(&conn, "n1", Some("root"), "N1", 1, "");
        insert_test_node(&conn, "n2", Some("root"), "N2", 2, "");

        move_node_in_conn(&mut conn, "n2".into(), Some("root".into()), 0)
            .expect("insert before moving down");

        assert_eq!(
            ordered_siblings(&conn, Some("root")),
            vec![
                ("n2".to_string(), 0),
                ("n0".to_string(), 1),
                ("n1".to_string(), 2),
            ]
        );
    }

    #[test]
    fn move_node_insert_before_same_parent_moving_up() {
        let mut conn = setup_test_conn();
        insert_test_node(&conn, "root", None, "Root", 0, "");
        insert_test_node(&conn, "n0", Some("root"), "N0", 0, "");
        insert_test_node(&conn, "n1", Some("root"), "N1", 1, "");
        insert_test_node(&conn, "n2", Some("root"), "N2", 2, "");

        move_node_in_conn(&mut conn, "n0".into(), Some("root".into()), 1)
            .expect("insert before moving up");

        assert_eq!(
            ordered_siblings(&conn, Some("root")),
            vec![
                ("n1".to_string(), 0),
                ("n0".to_string(), 1),
                ("n2".to_string(), 2),
            ]
        );
    }

    #[test]
    fn move_node_insert_before_cross_parent_into_middle() {
        let mut conn = setup_test_conn();
        setup_move_test_tree(&conn);

        move_node_in_conn(&mut conn, "a1".into(), Some("root".into()), 1)
            .expect("cross-parent insert");

        let a1_parent: Option<String> = conn
            .query_row("SELECT parent_id FROM notes WHERE id='a1'", [], |r| r.get(0))
            .expect("a1 parent");
        assert_eq!(a1_parent, Some("root".to_string()));
        assert_eq!(
            ordered_siblings(&conn, Some("root")),
            vec![
                ("a".to_string(), 0),
                ("a1".to_string(), 1),
                ("b".to_string(), 2),
            ]
        );
        assert_eq!(ordered_siblings(&conn, Some("a")), Vec::<(String, i64)>::new());
    }

    #[test]
    fn move_node_insert_before_outdent_to_root_middle() {
        let mut conn = setup_test_conn();
        insert_test_node(&conn, "root", None, "Root", 0, "");
        insert_test_node(&conn, "r0", Some("root"), "R0", 0, "");
        insert_test_node(&conn, "r1", Some("root"), "R1", 1, "");
        insert_test_node(&conn, "r2", Some("root"), "R2", 2, "");
        insert_test_node(&conn, "branch", Some("r0"), "Branch", 0, "");
        insert_test_node(&conn, "leaf", Some("branch"), "Leaf", 0, "");

        move_node_in_conn(&mut conn, "leaf".into(), Some("root".into()), 1)
            .expect("outdent to root middle");

        let leaf_parent: Option<String> = conn
            .query_row("SELECT parent_id FROM notes WHERE id='leaf'", [], |r| r.get(0))
            .expect("leaf parent");
        assert_eq!(leaf_parent, Some("root".to_string()));
        assert_eq!(
            ordered_siblings(&conn, Some("root")),
            vec![
                ("r0".to_string(), 0),
                ("leaf".to_string(), 1),
                ("r1".to_string(), 2),
                ("r2".to_string(), 3),
            ]
        );
        assert_eq!(
            ordered_siblings(&conn, Some("branch")),
            Vec::<(String, i64)>::new()
        );
    }

    fn insert_level_chain(conn: &Connection, count: i64, prefix: &str) -> String {
        let mut parent: Option<String> = None;
        let mut last = String::new();
        for index in 1..=count {
            let id = format!("{prefix}{index}");
            insert_test_node(conn, &id, parent.as_deref(), &id, 0, "");
            parent = Some(id.clone());
            last = id;
        }
        last
    }

    #[test]
    fn add_node_rejects_child_at_max_level() {
        let mut conn = setup_test_conn();
        let deepest = insert_level_chain(&conn, MAX_TREE_LEVEL, "n");
        let err = add_node_in_conn(&mut conn, Some(deepest), "too deep".into())
            .expect_err("depth cap");
        assert!(err.contains("nested up to 20"));
        assert!(err.contains("child cannot be added"));
    }

    #[test]
    fn add_node_allows_child_just_below_max_level() {
        let mut conn = setup_test_conn();
        let parent = insert_level_chain(&conn, MAX_TREE_LEVEL - 1, "n");
        add_node_in_conn(&mut conn, Some(parent), "ok".into()).expect("add");
    }

    #[test]
    fn move_node_rejects_reparent_past_max_level() {
        let mut conn = setup_test_conn();
        let deepest = insert_level_chain(&conn, MAX_TREE_LEVEL, "n");
        insert_test_node(&conn, "leaf", None, "Leaf", 1, "");
        let err = move_node_in_conn(&mut conn, "leaf".into(), Some(deepest), 0)
            .expect_err("depth cap");
        assert!(err.contains("Moving this branch here would nest it too deeply"));
    }

    #[test]
    fn move_node_allows_over_cap_branch_to_root() {
        let mut conn = setup_test_conn();
        insert_level_chain(&conn, MAX_TREE_LEVEL + 2, "n");
        move_node_in_conn(&mut conn, "n3".into(), None, 0).expect("to root");
        let parent: Option<String> = conn
            .query_row("SELECT parent_id FROM notes WHERE id='n3'", [], |r| r.get(0))
            .expect("parent");
        assert_eq!(parent, None);
    }

    #[test]
    fn delete_node_removes_the_entire_branch_only() {
        let mut conn = setup_test_conn();
        insert_test_node(&conn, "root", None, "Root", 0, "root");
        insert_test_node(&conn, "branch", Some("root"), "Branch", 0, "branch");
        insert_test_node(&conn, "leaf", Some("branch"), "Leaf", 0, "leaf");
        insert_test_node(&conn, "other", Some("root"), "Other", 1, "other");

        delete_node_in_conn(&mut conn, "branch").expect("delete branch");

        let remaining: Vec<String> = conn
            .prepare("SELECT id FROM notes ORDER BY id")
            .expect("prepare")
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<rusqlite::Result<_>>()
            .expect("rows");
        assert_eq!(remaining, vec!["other".to_string(), "root".to_string()]);
    }

    #[test]
    fn export_single_branch_includes_only_descendants() {
        let conn = setup_test_conn();
        insert_test_node(&conn, "root", None, "Root", 0, "root");
        insert_test_node(&conn, "branch", Some("root"), "Branch", 0, "branch");
        insert_test_node(&conn, "leaf", Some("branch"), "Leaf", 0, "leaf");
        insert_test_node(&conn, "other", Some("root"), "Other", 1, "other");

        let exported = export_single_branch(&conn, "branch").expect("export branch");
        assert_eq!(exported.label, "Branch");
        assert_eq!(exported.children.len(), 1);
        assert_eq!(exported.children[0].label, "Leaf");

        let labels = collect_export_labels(&exported);
        assert!(!labels.contains(&"Root".to_string()));
        assert!(!labels.contains(&"Other".to_string()));
    }

    fn lock_test_data_root() -> MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    struct TestRoot {
        _guard: MutexGuard<'static, ()>,
        dir: PathBuf,
    }

    impl TestRoot {
        fn new(prefix: &str) -> Self {
            let guard = lock_test_data_root();
            let dir = std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()));
            fs::create_dir_all(&dir).expect("temp dir");
            remember_data_root(dir.clone());
            Self { _guard: guard, dir }
        }

        fn with_notebooks(prefix: &str) -> Self {
            let root = Self::new(prefix);
            fs::create_dir_all(data_root::notebooks_dir(&root.dir)).expect("notebooks");
            root
        }
    }

    impl std::ops::Deref for TestRoot {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.dir
        }
    }

    impl AsRef<Path> for TestRoot {
        fn as_ref(&self) -> &Path {
            &self.dir
        }
    }

    fn switch_test_dir() -> TestRoot {
        TestRoot::with_notebooks("treenote-switch")
    }

    fn write_valid_notebook(path: &Path) {
        let conn = Connection::open(path).expect("create notebook");
        conn.execute_batch(CREATE_NOTES_TABLE_SQL)
            .expect("create schema");
    }

    fn sample_settings(database_path: &str) -> AppSettings {
        AppSettings {
            database_path: database_path.to_string(),
            backup_interval_hours: 24,
            backup_retention: 7,
            last_backup_at: None,
            password_hash: None,
            editor_font_family: "system".into(),
            minimize_to_tray: true,
            backup_before_restore: true,
        }
    }

    fn assert_notebook_locked(path: &Path) {
        let err = notebook_lock::try_acquire(path).expect_err("should be locked");
        assert_eq!(err, notebook_lock::LOCK_CONFLICT_MESSAGE);
    }

    #[test]
    fn switch_to_locked_target_leaves_current_lock_intact() {
        let dir = switch_test_dir();
        let notebooks = data_root::notebooks_dir(&dir);
        let a = notebooks.join("a.sqlite3");
        let b = notebooks.join("b.sqlite3");
        write_valid_notebook(&a);
        write_valid_notebook(&b);
        let current = notebook_lock::try_acquire(&a).expect("lock a");
        let held_b = notebook_lock::try_acquire(&b).expect("lock b");

        let err = prepare_notebook_switch(&current, &b).expect_err("target locked");
        assert_eq!(err, notebook_lock::LOCK_CONFLICT_MESSAGE);
        assert_notebook_locked(&a);

        drop(held_b);
        drop(current);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn successful_switch_releases_previous_notebook_lock() {
        let dir = switch_test_dir();
        let notebooks = data_root::notebooks_dir(&dir);
        let a = notebooks.join("a.sqlite3");
        let b = notebooks.join("b.sqlite3");
        write_valid_notebook(&a);
        write_valid_notebook(&b);
        let current = notebook_lock::try_acquire(&a).expect("lock a");
        let prepared = prepare_notebook_switch(&current, &b).expect("prepare b");
        let settings = sample_settings(current.notebook_path().to_str().unwrap());
        let candidate = persist_switch_candidate(&settings, &b, |_| Ok(())).expect("persist");
        assert_eq!(candidate.database_path, b.to_string_lossy());

        drop(current);
        notebook_lock::try_acquire(&a).expect("a should be free after switch");
        assert_notebook_locked(&b);

        drop(prepared);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn successful_switch_persists_canonical_managed_path() {
        let dir = switch_test_dir();
        let notebooks = data_root::notebooks_dir(&dir);
        let a = notebooks.join("a.sqlite3");
        let b = notebooks.join("b.sqlite3");
        write_valid_notebook(&a);
        write_valid_notebook(&b);
        let current = notebook_lock::try_acquire(&a).expect("lock a");
        let prepared = prepare_notebook_switch(&current, &b).expect("prepare b");
        let canonical = prepared.lock.notebook_path().to_path_buf();
        let settings = sample_settings(&a.to_string_lossy());
        let candidate = persist_switch_candidate(&settings, &canonical, |_| Ok(())).expect("persist");
        assert_eq!(candidate.database_path, canonical.to_string_lossy());
        drop(current);
        drop(prepared);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn switch_open_failure_after_taking_lock_keeps_current() {
        let dir = switch_test_dir();
        let notebooks = data_root::notebooks_dir(&dir);
        let a = notebooks.join("a.sqlite3");
        let b = notebooks.join("b.sqlite3");
        write_valid_notebook(&a);
        fs::create_dir_all(&b).expect("b as directory");
        let current = notebook_lock::try_acquire(&a).expect("lock a");

        let err = prepare_notebook_switch(&current, &b).expect_err("open should fail");
        assert!(!err.is_empty());
        assert_notebook_locked(&a);

        drop(current);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_persist_failure_leaves_current_locked_and_target_free() {
        let dir = switch_test_dir();
        let a = data_root::notebooks_dir(&dir).join("a.sqlite3");
        let b = data_root::notebooks_dir(&dir).join("b.sqlite3");
        write_valid_notebook(&a);
        write_valid_notebook(&b);
        let current = notebook_lock::try_acquire(&a).expect("lock a");
        let prepared = prepare_notebook_switch(&current, &b).expect("prepare b");
        let settings = sample_settings(current.notebook_path().to_str().unwrap());
        let err =
            persist_switch_candidate(&settings, &b, |_| Err("failed to write settings".into()))
                .expect_err("persist should fail");
        assert_eq!(err, "failed to write settings");
        assert_eq!(
            settings.database_path,
            current.notebook_path().to_string_lossy()
        );

        drop(prepared);
        assert_notebook_locked(&a);
        notebook_lock::try_acquire(&b).expect("b should be free after persist failure");

        drop(current);
        let _ = fs::remove_dir_all(&dir);
    }

    fn collect_export_labels(node: &ExportNode) -> Vec<String> {
        let mut labels = vec![node.label.clone()];
        for child in &node.children {
            labels.extend(collect_export_labels(child));
        }
        labels
    }

    #[test]
    fn restore_notes_replaces_live_contents() {
        let dir = std::env::temp_dir().join(format!("treenote-restore-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp dir");
        let live_path = dir.join("live.sqlite3");
        let backup_path = dir.join("backup.sqlite3");

        let live = Connection::open(&live_path).expect("open live");
        live.execute_batch(CREATE_NOTES_TABLE_SQL)
            .expect("live schema");
        insert_test_node(&live, "live", None, "Live", 0, "live content");

        let backup = Connection::open(&backup_path).expect("open backup");
        backup
            .execute_batch(CREATE_NOTES_TABLE_SQL)
            .expect("backup schema");
        insert_test_node(&backup, "restored", None, "Restored", 0, "restored content");
        drop(backup);

        restore_notes_from_backup_path(&live, &backup_path).expect("restore");

        let label: String = live
            .query_row("SELECT label FROM notes", [], |row| row.get(0))
            .expect("query restored");
        assert_eq!(label, "Restored");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn incompatible_backup_missing_column_fails_before_restore() {
        let dir = std::env::temp_dir().join(format!("treenote-restore-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp dir");
        let live_path = dir.join("live.sqlite3");
        let backup_path = dir.join("backup.sqlite3");

        let live = Connection::open(&live_path).expect("open live");
        live.execute_batch(CREATE_NOTES_TABLE_SQL)
            .expect("live schema");
        insert_test_node(&live, "live", None, "Live", 0, "live content");

        let backup = Connection::open(&backup_path).expect("open backup");
        backup
            .execute_batch(
                "CREATE TABLE notes (id TEXT PRIMARY KEY, label TEXT NOT NULL, sort_order INTEGER NOT NULL);",
            )
            .expect("legacy schema");
        backup
            .execute(
                "INSERT INTO notes (id, label, sort_order) VALUES ('old', 'Old', 0)",
                [],
            )
            .expect("insert legacy");
        drop(backup);

        let err = restore_notes_from_backup_path(&live, &backup_path).expect_err("incompatible");
        assert!(err.contains("missing required notes column"));

        let label: String = live
            .query_row("SELECT label FROM notes", [], |row| row.get(0))
            .expect("live unchanged");
        assert_eq!(label, "Live");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_transaction_failure_leaves_original_rows() {
        let dir = std::env::temp_dir().join(format!("treenote-restore-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp dir");
        let live_path = dir.join("live.sqlite3");
        let backup_path = dir.join("backup.sqlite3");

        let live = Connection::open(&live_path).expect("open live");
        live.execute_batch(CREATE_NOTES_TABLE_SQL)
            .expect("live schema");
        insert_test_node(&live, "live", None, "Live", 0, "live content");

        let backup = Connection::open(&backup_path).expect("open backup");
        backup
            .execute_batch(
                "CREATE TABLE notes (
                    id TEXT PRIMARY KEY,
                    parent_id TEXT,
                    label TEXT,
                    is_expanded INTEGER,
                    sort_order INTEGER NOT NULL,
                    content TEXT
                );",
            )
            .expect("backup schema");
        backup
            .execute(
                "INSERT INTO notes (id, parent_id, label, is_expanded, sort_order, content) VALUES ('bad', NULL, NULL, 1, 0, 'invalid')",
                [],
            )
            .expect("insert invalid row");
        drop(backup);

        let err = restore_notes_from_backup_path(&live, &backup_path).expect_err("duplicate id");
        assert!(!err.is_empty());

        let count: i64 = live
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn get_node_content_missing_row_returns_error() {
        let conn = setup_test_conn();
        let result = conn.query_row(
            "SELECT COALESCE(content,'') FROM notes WHERE id=?1",
            params!["missing"],
            |r| r.get::<_, String>(0),
        );
        assert!(result.is_err());
    }

    #[test]
    fn update_node_content_zero_rows_returns_error() {
        let conn = setup_test_conn();
        let changed = conn
            .execute(
                "UPDATE notes SET content=?1 WHERE id=?2",
                params!["x", "missing"],
            )
            .expect("execute");
        assert_eq!(changed, 0);
    }

    #[test]
    fn backup_snapshot_produces_openable_database() {
        use crate::backup::backup_filename_for_timestamp;
        use rusqlite::backup::Backup;
        use std::time::Duration;

        let dir = std::env::temp_dir().join(format!("treenote-snap-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp dir");
        let live_path = dir.join("live.sqlite3");
        let live = Connection::open(&live_path).expect("open live");
        live.execute_batch(CREATE_NOTES_TABLE_SQL).expect("schema");
        insert_test_node(&live, "n1", None, "Note", 0, "body");

        let dest = dir.join(backup_filename_for_timestamp(1_700_000_000));
        let mut dest_conn = Connection::open(&dest).expect("open dest");
        let backup = Backup::new(&live, &mut dest_conn).expect("backup");
        backup
            .run_to_completion(5, Duration::from_millis(250), None)
            .expect("run backup");
        drop(backup);
        drop(dest_conn);

        validate_sqlite_integrity(&dest).expect("integrity");
        let backup = Connection::open_with_flags(&dest, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("open backup");
        let content: String = backup
            .query_row("SELECT content FROM notes WHERE id='n1'", [], |row| {
                row.get(0)
            })
            .expect("read backup");
        assert_eq!(content, "body");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_settings_write_preserves_previous_on_replace_failure() {
        let dir = std::env::temp_dir().join(format!("treenote-settings-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp dir");
        remember_data_root(dir.clone());
        let settings_file = dir.join("settings.json");
        let original = serde_json::to_string(&AppSettings {
            database_path: "keep-me".into(),
            backup_interval_hours: 24,
            backup_retention: 7,
            last_backup_at: None,
            password_hash: None,
            editor_font_family: "system".into(),
            minimize_to_tray: true,
            backup_before_restore: true,
        })
        .expect("serialize original");
        fs::write(&settings_file, &original).expect("write original");

        let replacement = serde_json::to_string(&default_settings_on(&dir)).expect("serialize new");
        let tmp = dir.join("settings.json.tmp.test");
        fs::write(&tmp, replacement).expect("write tmp");

        #[cfg(windows)]
        {
            use std::fs::OpenOptions;
            use std::os::windows::fs::OpenOptionsExt;
            let err = {
                let _lock = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .share_mode(0)
                    .open(&settings_file)
                    .expect("exclusive lock");
                atomic_file::atomic_replace_file(&tmp, &settings_file).expect_err("replace fails")
            };
            assert!(!err.is_empty());
            let still = fs::read_to_string(&settings_file).expect("read preserved");
            assert!(still.contains("keep-me"));
            let replacement_path = default_settings_on(&dir).database_path;
            assert!(!still.contains(&replacement_path));
        }

        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&dir).expect("dir metadata").permissions();
            perms.set_mode(0o555);
            fs::set_permissions(&dir, perms).expect("make dir read-only");
            let err = atomic_file::atomic_replace_file(&tmp, &settings_file).expect_err("replace fails");
            assert!(!err.is_empty());
            perms.set_mode(0o700);
            fs::set_permissions(&dir, perms).expect("restore dir permissions");
            let still = fs::read_to_string(&settings_file).expect("read preserved");
            assert!(still.contains("keep-me"));
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_settings_write_creates_new_file() {
        let dir = std::env::temp_dir().join(format!("treenote-settings-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp dir");
        let settings_file = dir.join("settings.json");
        assert!(!settings_file.exists());
        let settings = default_settings_on(&dir);
        let json = serde_json::to_string_pretty(&settings).expect("serialize");
        write_settings_json_atomically(&settings_file, &json).expect("first write");
        assert!(settings_file.exists());
        let read_back: AppSettings =
            serde_json::from_str(&fs::read_to_string(&settings_file).expect("read"))
                .expect("parse");
        assert_eq!(read_back.database_path, settings.database_path);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recovery_does_not_create_missing_notebook_file() {
        let dir = std::env::temp_dir().join(format!("treenote-recovery-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp dir");
        let missing = dir.join("missing.sqlite3");
        assert!(!missing.exists());
        let err = open_notebook_for_recovery(&missing).expect_err("missing notebook");
        assert!(err.contains("Notebook not found"));
        assert!(!missing.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recovery_rejects_non_treenote_sqlite_without_modifying_it() {
        let dir = std::env::temp_dir().join(format!("treenote-recovery-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp dir");
        let alien = dir.join("alien.sqlite3");
        {
            let conn = Connection::open(&alien).expect("create empty sqlite");
            let table_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                    [],
                    |row| row.get(0),
                )
                .expect("count tables");
            assert_eq!(table_count, 0);
        }
        let err = open_notebook_for_recovery(&alien).expect_err("not a treenote notebook");
        assert!(err.contains("not a TreeNote notebook"));
        let conn =
            Connection::open_with_flags(&alien, OpenFlags::SQLITE_OPEN_READ_ONLY).expect("reopen");
        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                [],
                |row| row.get(0),
            )
            .expect("count tables");
        assert_eq!(table_count, 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recovery_opens_valid_existing_notebook() {
        let dir = std::env::temp_dir().join(format!("treenote-recovery-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp dir");
        let notebook = dir.join("valid.sqlite3");
        {
            let conn = Connection::open(&notebook).expect("create notebook");
            conn.execute_batch(CREATE_NOTES_TABLE_SQL)
                .expect("create schema");
            insert_test_node(&conn, "n1", None, "Note", 0, "body");
        }
        let conn = open_notebook_for_recovery(&notebook).expect("open recovery notebook");
        let label: String = conn
            .query_row("SELECT label FROM notes WHERE id='n1'", [], |row| {
                row.get(0)
            })
            .expect("read note");
        assert_eq!(label, "Note");
        let _ = fs::remove_dir_all(&dir);
    }

    fn startup_test_fs(dir: &Path) -> StartupFs {
        fs::create_dir_all(data_root::notebooks_dir(dir)).expect("notebooks");
        StartupFs {
            data_root: dir.to_path_buf(),
        }
    }

    fn alien_sqlite(path: &Path) {
        let conn = Connection::open(path).expect("create alien sqlite");
        conn.execute_batch("CREATE TABLE other (id INTEGER PRIMARY KEY);")
            .expect("alien schema");
        conn.execute("INSERT INTO other (id) VALUES (1)", [])
            .expect("alien row");
    }

    fn recover_settings(action: StartupAction) -> Option<AppSettings> {
        match action {
            StartupAction::RecoverNotebook {
                preserve_settings, ..
            } => preserve_settings,
            other => panic!("expected recovery, got {other:?}"),
        }
    }

    fn recover_message(action: StartupAction) -> String {
        match action {
            StartupAction::RecoverNotebook { message, .. } => message,
            other => panic!("expected recovery, got {other:?}"),
        }
    }

    #[test]
    fn root_dependent_paths_propagate_resolver_failure_without_appdata_fallback() {
        let failure = Err("registry read failed".to_string());
        let settings_err = data_root::resolve_data_root_from_configured(failure.clone())
            .map(|root| data_root::settings_path(&root))
            .expect_err("settings path should fail");
        assert_eq!(settings_err, "registry read failed");

        let export_err = data_root::resolve_data_root_from_configured(failure)
            .map(|root| path_to_setting(&data_root::exports_dir(&root)))
            .expect_err("export path should fail");
        assert_eq!(export_err, "registry read failed");
        assert_ne!(
            export_err,
            path_to_setting(&data_root::exports_dir(&data_root::default_data_root()))
        );
    }

    #[test]
    fn public_settings_uses_remembered_exports_dir() {
        let dir = TestRoot::new("treenote-public-settings");
        let settings = sample_settings(
            &data_root::notebooks_dir(&dir)
                .join("work.sqlite3")
                .to_string_lossy(),
        );
        let public = public_settings_from(settings).expect("public settings");
        assert_eq!(
            public.export_folder,
            path_to_setting(&data_root::exports_dir(&dir))
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_database_path_normalizes_to_managed_default() {
        let dir = TestRoot::new("treenote-normalize");
        let parsed: AppSettings = serde_json::from_str(
            r#"{
            "database_path": "",
            "editor_font_family": "system"
        }"#,
        )
        .expect("parse settings");
        let migrated = normalize_settings_on(parsed, &dir);
        assert_eq!(
            Path::new(&migrated.database_path),
            data_root::default_notebook_path(&dir).as_path()
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unmanaged_database_path_causes_recovery_and_leaves_external_file() {
        let dir = TestRoot::new("treenote-unmanaged");
        let fs_paths = startup_test_fs(&dir);
        let external = dir.join("outside.sqlite3");
        write_valid_notebook(&external);
        let before = fs::read(&external).expect("read external");
        let settings = sample_settings(&external.to_string_lossy());
        save_settings_to_path(&fs_paths.settings_path(), &settings).expect("write settings");

        let action = prepare_startup_on(&fs_paths).expect("startup");
        let preserved = recover_settings(action).expect("keep settings");
        assert_eq!(preserved.database_path, external.to_string_lossy());
        assert_eq!(fs::read(&external).expect("unchanged"), before);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_settings_enter_recovery_without_writing_settings() {
        let dir = TestRoot::new("treenote-corrupt");
        let fs_paths = startup_test_fs(&dir);
        fs::write(&fs_paths.settings_path(), "{not-json").expect("corrupt settings");

        let action = prepare_startup_on(&fs_paths).expect("startup");
        assert!(recover_settings(action).is_none());
        assert_eq!(
            fs::read_to_string(&fs_paths.settings_path()).expect("read"),
            "{not-json"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_managed_notebook_reports_missing_message() {
        let dir = TestRoot::new("treenote-missing-msg");
        let fs_paths = startup_test_fs(&dir);
        let remembered = data_root::notebooks_dir(&dir).join("gone.sqlite3");
        let settings = sample_settings(&remembered.to_string_lossy());
        save_settings_to_path(&fs_paths.settings_path(), &settings).expect("write settings");

        let action = prepare_startup_on(&fs_paths).expect("startup");
        let message = recover_message(action);
        assert!(message.contains("could not find the remembered notebook"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_managed_notebook_enters_recovery() {
        let dir = TestRoot::new("treenote-missing");
        let fs_paths = startup_test_fs(&dir);
        let remembered = data_root::notebooks_dir(&dir).join("gone.sqlite3");
        let settings = sample_settings(&remembered.to_string_lossy());
        save_settings_to_path(&fs_paths.settings_path(), &settings).expect("write settings");

        let action = prepare_startup_on(&fs_paths).expect("startup");
        let preserved = recover_settings(action).expect("keep settings");
        assert_eq!(preserved.database_path, remembered.to_string_lossy());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn absent_settings_create_fresh_default_when_notebooks_empty() {
        let dir = TestRoot::new("treenote-fresh");
        let fs_paths = startup_test_fs(&dir);
        let action = prepare_startup_on(&fs_paths);
        assert!(data_root::default_notebook_path(&dir).is_file());
        match action {
            Ok(StartupAction::Continue) => {}
            Err(error) if error.contains("Notebook is not open") => {}
            other => panic!("expected fresh create, got {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn absent_settings_reuse_sole_default_notebook() {
        let dir = TestRoot::new("treenote-reuse-default");
        let fs_paths = startup_test_fs(&dir);
        let notebook = data_root::default_notebook_path(&dir);
        write_valid_notebook(&notebook);
        let action = prepare_startup_on(&fs_paths);
        match action {
            Ok(StartupAction::Continue) => {}
            Err(error) if error.contains("Notebook is not open") => {}
            other => panic!("expected reuse, got {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn absent_settings_with_multiple_managed_notebooks_recovers() {
        let dir = TestRoot::new("treenote-multi");
        let fs_paths = startup_test_fs(&dir);
        write_valid_notebook(&data_root::notebooks_dir(&dir).join(DEFAULT_NOTEBOOK_FILENAME));
        write_valid_notebook(&data_root::notebooks_dir(&dir).join("work.sqlite3"));
        let action = prepare_startup_on(&fs_paths).expect("startup");
        assert!(recover_settings(action).is_none());
        assert!(!fs_paths.settings_path().exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn absent_settings_with_sole_non_default_notebook_recovers() {
        let dir = TestRoot::new("treenote-sole-other");
        let fs_paths = startup_test_fs(&dir);
        write_valid_notebook(&data_root::notebooks_dir(&dir).join("work.sqlite3"));
        let action = prepare_startup_on(&fs_paths).expect("startup");
        assert!(recover_settings(action).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fresh_default_alien_sqlite_is_left_byte_for_byte_unchanged() {
        let dir = TestRoot::new("treenote-alien-fresh");
        let fs_paths = startup_test_fs(&dir);
        let alien = data_root::default_notebook_path(&dir);
        alien_sqlite(&alien);
        let before = fs::read(&alien).expect("read alien before");

        let action = prepare_startup_on(&fs_paths).expect("startup");
        assert!(recover_settings(action).is_none());
        assert_eq!(fs::read(&alien).expect("read alien after"), before);
        assert!(!fs_paths.settings_path().exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn enumeration_omits_alien_and_does_not_modify_it() {
        let dir = std::env::temp_dir().join(format!("treenote-enum-{}", Uuid::new_v4()));
        let notebooks = data_root::notebooks_dir(&dir);
        fs::create_dir_all(&notebooks).expect("notebooks");
        let valid = notebooks.join("work.sqlite3");
        let alien = notebooks.join("alien.sqlite3");
        write_valid_notebook(&valid);
        alien_sqlite(&alien);
        let before = fs::read(&alien).expect("before");
        let names = list_valid_managed_notebook_names(&notebooks).expect("list");
        assert_eq!(names, vec!["work.sqlite3".to_string()]);
        assert_eq!(fs::read(&alien).expect("after"), before);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_notebook_does_not_switch_active_database() {
        let dir = switch_test_dir();
        let created = create_notebook("ideas".into()).expect("create");
        assert_eq!(created, "ideas.sqlite3");
        assert!(data_root::notebooks_dir(&dir).join("ideas.sqlite3").is_file());
        let current = SETTINGS.lock().expect("settings").database_path.clone();
        assert!(!current.ends_with("ideas.sqlite3"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_notebook_rejects_escape_and_separator_names() {
        let dir = switch_test_dir();
        assert!(create_notebook("../escape".into()).is_err());
        assert!(create_notebook("a/b".into()).is_err());
        assert!(create_notebook("a\\b".into()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_destination_is_managed_and_refuses_duplicates() {
        let dir = switch_test_dir();
        let dest = resolve_import_destination("imported").expect("resolve");
        assert_eq!(dest.file_name().unwrap(), "imported.sqlite3");
        assert!(!dest.exists());
        write_valid_notebook(&dest);
        let err = resolve_import_destination("imported").expect_err("duplicate");
        assert!(err.contains("already exists"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_notebook_file_exclusive_creates_schema_on_new_path() {
        let dir = std::env::temp_dir().join(format!("treenote-create-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("new.sqlite3");
        let (lock, conn) = create_notebook_file_exclusive(&path).expect("create");
        assert!(path.is_file());
        validate_existing_notebook_schema(&conn).expect("schema");
        drop(conn);
        drop(lock);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_notebook_file_exclusive_refuses_existing_file_without_modifying_it() {
        let dir = std::env::temp_dir().join(format!("treenote-create-exists-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("exists.sqlite3");
        alien_sqlite(&path);
        let before = fs::read(&path).expect("read before");
        let err = create_notebook_file_exclusive(&path).expect_err("must refuse");
        assert!(err.contains("already exists"));
        assert_eq!(fs::read(&path).expect("read after"), before);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn persist_recovery_failure_does_not_replace_remembered_database_path() {
        let dir = TestRoot::new("treenote-persist-fail");
        let settings_file = dir.join("settings.json");
        let remembered = dir.join("old.sqlite3");
        let original = sample_settings(&remembered.to_string_lossy());
        save_settings_to_path(&settings_file, &original).expect("write original");
        let selected = dir.join("new.sqlite3");
        let err = persist_recovery_candidate(&selected, Some(original.clone()), |_| {
            Err("failed to write settings".into())
        })
        .expect_err("persist should fail");
        assert_eq!(err, "failed to write settings");
        let on_disk: AppSettings =
            serde_json::from_str(&fs::read_to_string(&settings_file).expect("read"))
                .expect("parse");
        assert_eq!(on_disk.database_path, remembered.to_string_lossy());
        assert_eq!(on_disk.database_path, original.database_path);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_locate_persistence_releases_lock_and_allows_retry() {
        let dir = TestRoot::new("treenote-locate-retry");
        let notebook = dir.join("valid.sqlite3");
        {
            let conn = Connection::open(&notebook).expect("create notebook");
            conn.execute_batch(CREATE_NOTES_TABLE_SQL)
                .expect("create schema");
            insert_test_node(&conn, "n1", None, "Note", 0, "body");
        }
        let prepared = prepare_recovery_locate(&notebook).expect("prepare locate");
        let remembered = sample_settings(&dir.join("old.sqlite3").to_string_lossy());
        let err = persist_recovery_candidate(&notebook, Some(remembered.clone()), |_| {
            Err("failed to write settings".into())
        })
        .expect_err("persist should fail");
        assert_eq!(err, "failed to write settings");
        abandon_prepared_recovery(prepared);
        notebook_lock::try_acquire(&notebook).expect("lock released after failed locate");
        let retry = prepare_recovery_locate(&notebook).expect("retry locate");
        assert!(notebook.is_file());
        drop(retry);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_create_persistence_releases_lock_and_removes_only_new_notebook() {
        let dir = TestRoot::new("treenote-create-retry");
        let existing = dir.join("existing.sqlite3");
        alien_sqlite(&existing);
        let existing_bytes = fs::read(&existing).expect("read existing");
        let created = dir.join("created.sqlite3");
        let prepared = prepare_recovery_create(&created).expect("prepare create");
        assert!(created.is_file());
        let remembered = sample_settings(&dir.join("old.sqlite3").to_string_lossy());
        let err = persist_recovery_candidate(&created, Some(remembered.clone()), |_| {
            Err("failed to write settings".into())
        })
        .expect_err("persist should fail");
        assert_eq!(err, "failed to write settings");
        abandon_prepared_recovery(prepared);
        assert!(!created.exists());
        notebook_lock::try_acquire(&created).expect("create lock released");
        assert_eq!(
            fs::read(&existing).expect("existing preserved"),
            existing_bytes
        );
        let retry = prepare_recovery_create(&created).expect("retry create");
        assert!(created.is_file());
        drop(retry);
        let _ = fs::remove_dir_all(&dir);
    }

    fn write_valid_managed_backup(dir: &Path, timestamp: u64, content: &str) {
        let path = dir.join(backup_filename_for_timestamp(timestamp));
        let conn = Connection::open(&path).expect("open backup");
        conn.execute_batch(CREATE_NOTES_TABLE_SQL)
            .expect("backup schema");
        insert_test_node(&conn, "n1", None, "Note", 0, content);
    }

    fn inprogress_partial_paths(dir: &Path) -> Vec<PathBuf> {
        fs::read_dir(dir)
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with(".treenote-backup-inprogress-") && name.ends_with(".partial")
            })
            .map(|entry| entry.path())
            .collect()
    }

    fn install_live_notebook_for_backup_tests(
        dir: &Path,
        initial_content: &str,
    ) -> (AppSettings, PathBuf) {
        remember_data_root(dir.to_path_buf());
        let db_path = dir.join("live.sqlite3");
        let backup_root = data_root::backups_dir(dir);
        fs::create_dir_all(&backup_root).expect("backup root");
        let conn = Connection::open(&db_path).expect("open live");
        conn.execute_batch(CREATE_NOTES_TABLE_SQL)
            .expect("live schema");
        insert_test_node(&conn, "n1", None, "Note", 0, initial_content);
        let lock = notebook_lock::try_acquire(&db_path).expect("lock live");
        if DB_CONNECTION.get().is_none() {
            install_notebook(lock, conn).expect("install notebook");
        } else {
            drop(conn);
            drop(lock);
        }
        {
            let live = db_connection().expect("live connection");
            live.execute("DELETE FROM notes WHERE id='n1'", [])
                .expect("clear n1");
            insert_test_node(&live, "n1", None, "Note", 0, initial_content);
        }
        let settings = sample_settings(&db_path.to_string_lossy());
        {
            let mut stored = SETTINGS.lock().expect("settings lock");
            *stored = settings.clone();
        }
        let notebook_dir = managed_notebook_dir(
            &path_to_setting(&backup_root),
            &settings.database_path,
        );
        fs::create_dir_all(&notebook_dir).expect("managed dir");
        (settings, notebook_dir)
    }

    #[test]
    fn managed_backup_live_snapshot_integration() {
        use crate::backup::backups_to_keep;

        let dir = TestRoot::new("treenote-backup-integ");
        let (settings, notebook_dir) =
            install_live_notebook_for_backup_tests(&dir, "stable-content");

        {
            let conn = db_connection().expect("live connection");
            for i in 0..50 {
                conn.execute(
                    "UPDATE notes SET content=?1 WHERE id='n1'",
                    params![format!("revision-{i}")],
                )
                .expect("rapid write");
            }
        }

        let (created_dir, timestamp) =
            create_managed_backup_without_prune(&settings, None).expect("managed backup");
        assert_eq!(created_dir, notebook_dir);
        let dest = notebook_dir.join(backup_filename_for_timestamp(timestamp));
        validate_sqlite_integrity(&dest).expect("backup integrity");
        let backup_conn =
            Connection::open_with_flags(&dest, OpenFlags::SQLITE_OPEN_READ_ONLY).expect("open");
        let backed_up: String = backup_conn
            .query_row("SELECT content FROM notes WHERE id='n1'", [], |row| {
                row.get(0)
            })
            .expect("read backup");
        assert!(
            backed_up.starts_with("revision-"),
            "backup must contain a coherent revision, not torn data"
        );
        let note_count: i64 = backup_conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .expect("count notes");
        assert_eq!(note_count, 1);

        let existing_ts = 1_700_000_000u64;
        write_valid_managed_backup(&notebook_dir, existing_ts, "existing-body");
        let prune_candidate_ts = existing_ts - 25 * 3600;
        write_valid_managed_backup(&notebook_dir, prune_candidate_ts, "prune-me");
        for i in 1..=24 {
            write_valid_managed_backup(&notebook_dir, existing_ts - i * 3600, &format!("hour-{i}"));
        }
        let now = existing_ts + 60;
        let setup_timestamps = list_managed_backup_timestamps(&notebook_dir).expect("list");
        let keep = backups_to_keep(&setup_timestamps, now);
        assert!(
            !keep.contains(&prune_candidate_ts),
            "test setup requires a prune-eligible backup"
        );

        let (blocked_dest, _reserved_ts) =
            reserve_unique_backup_dest(&notebook_dir).expect("reserve dest");
        fs::write(&blocked_dest, b"blocked-destination").expect("block promote");
        let existing_bytes = fs::read(&blocked_dest).expect("read blocked dest");
        let timestamps_before = list_managed_backup_timestamps(&notebook_dir).expect("list");

        let err = snapshot_live_notebook_to_path(&blocked_dest).expect_err("promote blocked");
        assert!(!err.is_empty());
        assert_eq!(
            fs::read(&blocked_dest).expect("dest preserved"),
            existing_bytes
        );
        assert!(inprogress_partial_paths(&notebook_dir).is_empty());

        let existing_path = notebook_dir.join(backup_filename_for_timestamp(existing_ts));
        validate_sqlite_integrity(&existing_path).expect("existing backup intact");
        let existing_content: String =
            Connection::open_with_flags(&existing_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .expect("open existing")
                .query_row("SELECT content FROM notes WHERE id='n1'", [], |row| {
                    row.get(0)
                })
                .expect("read existing");
        assert_eq!(existing_content, "existing-body");

        let timestamps_after = list_managed_backup_timestamps(&notebook_dir).expect("list after");
        assert_eq!(timestamps_after, timestamps_before);
        assert!(notebook_dir
            .join(backup_filename_for_timestamp(prune_candidate_ts))
            .is_file());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshot_progress_counts_uses_pagecount_as_total() {
        assert_eq!(snapshot_progress_counts(100, 40), (60, 100));
        assert_eq!(snapshot_progress_counts(100, 0), (100, 100));
        assert_eq!(snapshot_progress_counts(0, 0), (0, 0));
        assert_eq!(snapshot_progress_counts(-5, 3), (0, 0));
        assert_eq!(snapshot_progress_counts(10, -3), (10, 10));
        assert_eq!(snapshot_progress_counts(8, 8), (0, 8));
        let (done, total) = snapshot_progress_counts(50, 0);
        assert_eq!(done, total);
    }

    #[test]
    fn successful_backup_survives_metadata_write_failure() {
        let dir = std::env::temp_dir().join(format!("treenote-meta-fail-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("dir");
        let timestamp = 1_700_000_000u64;
        let backup_path = dir.join(backup_filename_for_timestamp(timestamp));
        fs::write(&backup_path, b"sqlite").expect("backup file");
        fs::create_dir_all(dir.join(crate::backup_meta::METADATA_FILENAME))
            .expect("metadata path is a directory");

        let (result, _) = finalize_backup_prune_and_metadata(
            &dir,
            timestamp,
            Some("label".into()),
            true,
        )
        .expect("backup itself must succeed");

        assert!(backup_path.is_file());
        assert!(!result.metadata_saved);
        let warning = result.metadata_warning.expect("warning");
        assert!(warning.contains("could not be saved"));
        let _ = fs::remove_dir_all(&dir);
    }
}
