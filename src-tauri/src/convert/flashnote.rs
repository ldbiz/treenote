use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use uuid::Uuid;

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

const CREATE_FLASHNOTE_NOTES3_SQL: &str = "
CREATE TABLE notes3(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pid INTEGER not null default 0,
    folderpos INTEGER not null default 1,
    name TEXT not null default '',
    note TEXT not null default '',
    pos INTEGER not null default 0,
    created TIMESTAMP not null default CURRENT_TIMESTAMP,
    modified TIMESTAMP not null default CURRENT_TIMESTAMP,
    trash boolean not null default 0,
    type INTEGER not null default 0
);";

const REQUIRED_COLUMNS: &[&str] = &[
    "id", "pid", "folderpos", "name", "note", "pos", "created", "modified", "trash", "type",
];

#[derive(Debug, Clone)]
struct FlashnoteRow {
    id: i64,
    pid: i64,
    folderpos: i64,
    name: String,
    note: String,
    trash: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct ImportSummary {
    pub notes_imported: usize,
    pub notes_skipped: usize,
    pub dest_path: String,
}

#[derive(Debug, Clone)]
pub struct TreenoteNote {
    pub id: String,
    pub parent_id: Option<String>,
    pub label: String,
    pub sort_order: i64,
    pub content: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ExportSummary {
    pub notes_exported: usize,
    pub dest_path: String,
}

pub fn import_flashnote(
    source_path: &Path,
    dest_path: &Path,
    current_database_path: &str,
) -> Result<ImportSummary, String> {
    if !source_path.is_file() {
        return Err(format!(
            "Flashnote database not found: {}",
            source_path.display()
        ));
    }
    if dest_path.exists() {
        return Err(format!(
            "A file already exists at {}. Choose a different location.",
            dest_path.display()
        ));
    }
    if paths_equal(dest_path, Path::new(current_database_path)) {
        return Err(
            "Cannot import into the currently open notebook. Choose a different file.".into(),
        );
    }

    let source = Connection::open_with_flags(source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| {
            "Could not read the selected file. Use an unencrypted Flashnote .db backup.".to_string()
        })?;
    validate_flashnote_schema(&source)?;

    let all_rows = load_flashnote_rows(&source)?;
    let total_rows = all_rows.len();
    let importable = filter_importable_rows(&all_rows);
    let notes_skipped = total_rows.saturating_sub(importable.len());

    if importable.is_empty() {
        return Err("No importable notes were found in the Flashnote database.".into());
    }

    let parent = dest_path
        .parent()
        .ok_or_else(|| "Invalid destination path.".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let temp_path = parent.join(format!(
        ".treenote-import-{}.partial",
        Uuid::new_v4()
    ));

    let import_result = write_treenote_notebook(&temp_path, &importable);
    if let Err(error) = import_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    fs::rename(&temp_path, dest_path).map_err(|e| {
        let _ = fs::remove_file(&temp_path);
        format!("Failed to create notebook: {}", e)
    })?;

    Ok(ImportSummary {
        notes_imported: importable.len(),
        notes_skipped,
        dest_path: dest_path.to_string_lossy().to_string(),
    })
}

pub fn export_flashnote(dest_path: &Path, notes: &[TreenoteNote]) -> Result<ExportSummary, String> {
    if dest_path.exists() {
        return Err(format!(
            "A file already exists at {}. Choose a different location.",
            dest_path.display()
        ));
    }
    if notes.is_empty() {
        return Err("No notes to export.".into());
    }

    let parent = dest_path
        .parent()
        .ok_or_else(|| "Invalid destination path.".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let temp_path = parent.join(format!(
        ".treenote-export-{}.partial",
        Uuid::new_v4()
    ));

    let notes_exported = match write_flashnote_database(&temp_path, notes) {
        Ok(count) => count,
        Err(error) => {
            let _ = fs::remove_file(&temp_path);
            return Err(error);
        }
    };

    fs::rename(&temp_path, dest_path).map_err(|e| {
        let _ = fs::remove_file(&temp_path);
        format!("Failed to create Flashnote database: {}", e)
    })?;

    Ok(ExportSummary {
        notes_exported,
        dest_path: dest_path.to_string_lossy().to_string(),
    })
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn validate_flashnote_schema(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='notes3'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| {
            "This file does not look like a Flashnote database (missing notes3 table).".to_string()
        })?;
    if count == 0 {
        return Err(
            "This file does not look like a Flashnote database (missing notes3 table).".to_string(),
        );
    }

    let mut stmt = conn
        .prepare("PRAGMA table_info(notes3)")
        .map_err(|_| "Could not read Flashnote database schema.".to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|_| "Could not read Flashnote database schema.".to_string())?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();

    for required in REQUIRED_COLUMNS {
        if !columns.iter().any(|c| c == required) {
            return Err(format!(
                "This Flashnote database is missing required column: {}",
                required
            ));
        }
    }
    Ok(())
}

fn load_flashnote_rows(conn: &Connection) -> Result<Vec<FlashnoteRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, pid, folderpos, name, note, trash \
             FROM notes3 ORDER BY folderpos, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(FlashnoteRow {
                id: row.get(0)?,
                pid: row.get(1)?,
                folderpos: row.get(2)?,
                name: row.get(3)?,
                note: row.get(4)?,
                trash: row.get::<_, i64>(5)? != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn filter_importable_rows(rows: &[FlashnoteRow]) -> Vec<FlashnoteRow> {
    let trashed_ids: HashSet<i64> = rows
        .iter()
        .filter(|row| row.trash)
        .map(|row| row.id)
        .collect();

    let mut excluded: HashSet<i64> = trashed_ids.clone();
    let mut changed = true;
    while changed {
        changed = false;
        for row in rows {
            if excluded.contains(&row.id) {
                continue;
            }
            if row.pid != 0 && excluded.contains(&row.pid) {
                excluded.insert(row.id);
                changed = true;
            }
        }
    }

    rows.iter()
        .filter(|row| !excluded.contains(&row.id))
        .cloned()
        .collect()
}

fn normalize_parent_pid(row: &FlashnoteRow, known_ids: &HashSet<i64>) -> i64 {
    if row.pid == 0 {
        return 0;
    }
    if known_ids.contains(&row.pid) {
        row.pid
    } else {
        0
    }
}

fn note_content(note: &str) -> String {
    if note.starts_with("{\\rtf") {
        rtf_to_plain_text(note)
    } else {
        note.to_string()
    }
}

fn rtf_to_plain_text(rtf: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = rtf.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' {
            i += 1;
            if i >= chars.len() {
                break;
            }
            if chars[i] == '\\' {
                out.push('\\');
                i += 1;
                continue;
            }
            if chars[i] == '{' || chars[i] == '}' {
                out.push(chars[i]);
                i += 1;
                continue;
            }
            if chars[i] == '\'' {
                if i + 2 < chars.len() {
                    let hex: String = chars[i + 1..i + 3].iter().collect();
                    if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                        out.push(byte as char);
                    }
                }
                i += 3;
                continue;
            }
            let start = i;
            while i < chars.len() && chars[i].is_ascii_alphabetic() {
                i += 1;
            }
            if i < chars.len() && chars[i] == '-' {
                i += 1;
            }
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            if i < chars.len() && chars[i] == ' ' {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            if word == "par" || word == "line" {
                out.push('\n');
            }
            continue;
        }
        if chars[i] == '{' || chars[i] == '}' {
            i += 1;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn label_from_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

fn name_for_flashnote(label: &str) -> String {
    let trimmed = label.trim();
    if trimmed.is_empty() || trimmed == "Untitled" {
        String::new()
    } else {
        trimmed.to_string()
    }
}

fn normalize_treenote_parent_id(
    note: &TreenoteNote,
    known_ids: &HashSet<String>,
) -> Option<String> {
    match &note.parent_id {
        None => None,
        Some(parent_id) if known_ids.contains(parent_id) => Some(parent_id.clone()),
        Some(_) => None,
    }
}

fn write_flashnote_database(dest_path: &Path, notes: &[TreenoteNote]) -> Result<usize, String> {
    let known_ids: HashSet<String> = notes.iter().map(|note| note.id.clone()).collect();
    let mut children_by_parent: HashMap<Option<String>, Vec<&TreenoteNote>> = HashMap::new();
    for note in notes {
        children_by_parent
            .entry(normalize_treenote_parent_id(note, &known_ids))
            .or_default()
            .push(note);
    }
    for children in children_by_parent.values_mut() {
        children.sort_by(|a, b| {
            a.sort_order
                .cmp(&b.sort_order)
                .then(a.label.cmp(&b.label))
                .then(a.id.cmp(&b.id))
        });
    }

    let conn = Connection::open(dest_path).map_err(|e| e.to_string())?;
    conn.execute_batch(CREATE_FLASHNOTE_NOTES3_SQL)
        .map_err(|e| e.to_string())?;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut next_id: i64 = 1;
    let exported = insert_flashnote_subtree(
        &tx,
        None,
        0,
        &children_by_parent,
        &mut next_id,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(exported)
}

fn insert_flashnote_subtree(
    conn: &Connection,
    parent_key: Option<&String>,
    parent_pid: i64,
    children_by_parent: &HashMap<Option<String>, Vec<&TreenoteNote>>,
    next_id: &mut i64,
) -> Result<usize, String> {
    let key = parent_key.cloned();
    let children = children_by_parent.get(&key).map(Vec::as_slice).unwrap_or(&[]);
    let mut exported = 0usize;
    for (index, note) in children.iter().enumerate() {
        let flash_id = *next_id;
        *next_id += 1;
        let folderpos = (index as i64) + 1;
        conn.execute(
            "INSERT INTO notes3 (id, pid, folderpos, name, note, pos, trash, type) \
             VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, 1)",
            params![
                flash_id,
                parent_pid,
                folderpos,
                name_for_flashnote(&note.label),
                &note.content,
            ],
        )
        .map_err(|e| e.to_string())?;
        exported += 1;
        exported += insert_flashnote_subtree(
            conn,
            Some(&note.id),
            flash_id,
            children_by_parent,
            next_id,
        )?;
    }
    Ok(exported)
}

fn write_treenote_notebook(dest_path: &Path, rows: &[FlashnoteRow]) -> Result<(), String> {
    let known_ids: HashSet<i64> = rows.iter().map(|row| row.id).collect();
    let id_map: HashMap<i64, String> = rows
        .iter()
        .map(|row| (row.id, Uuid::new_v4().to_string()))
        .collect();

    let mut children_by_parent: HashMap<i64, Vec<&FlashnoteRow>> = HashMap::new();
    for row in rows {
        let parent_pid = normalize_parent_pid(row, &known_ids);
        children_by_parent
            .entry(parent_pid)
            .or_default()
            .push(row);
    }

    for children in children_by_parent.values_mut() {
        children.sort_by(|a, b| a.folderpos.cmp(&b.folderpos).then(a.id.cmp(&b.id)));
    }

    let conn = Connection::open(dest_path).map_err(|e| e.to_string())?;
    conn.execute_batch(CREATE_NOTES_TABLE_SQL)
        .map_err(|e| e.to_string())?;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (parent_pid, children) in &children_by_parent {
        for (sort_order, row) in children.iter().enumerate() {
            let parent_id = if *parent_pid == 0 {
                None
            } else {
                id_map.get(parent_pid).cloned()
            };
            tx.execute(
                "INSERT INTO notes (id, parent_id, label, is_expanded, sort_order, content) \
                 VALUES (?1, ?2, ?3, 1, ?4, ?5)",
                params![
                    id_map[&row.id],
                    parent_id,
                    label_from_name(&row.name),
                    sort_order as i64,
                    note_content(&row.note),
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        std::env::temp_dir().join(format!("treenote-flashnote-test-{name}-{nanos}.db"))
    }

    fn create_flashnote_db(path: &Path, rows: &[(i64, i64, i64, &str, &str, i64)]) {
        if path.exists() {
            fs::remove_file(path).expect("remove old db");
        }
        let conn = Connection::open(path).expect("open flashnote db");
        conn.execute_batch(CREATE_FLASHNOTE_NOTES3_SQL)
            .expect("schema");
        for (id, pid, folderpos, name, note, trash) in rows {
            conn.execute(
                "INSERT INTO notes3 (id, pid, folderpos, name, note, trash) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, pid, folderpos, name, note, trash],
            )
            .expect("insert");
        }
    }

    fn read_treenote_rows(path: &Path) -> Vec<(Option<String>, String, i64, String)> {
        let conn = Connection::open(path).expect("open treenote db");
        let mut stmt = conn
            .prepare(
                "SELECT parent_id, label, sort_order, content FROM notes ORDER BY COALESCE(parent_id, ''), sort_order, label",
            )
            .expect("prepare");
        stmt.query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .expect("query")
        .filter_map(Result::ok)
        .collect()
    }

    #[test]
    fn imports_nested_tree_with_folderpos_order_and_new_ids() {
        let source = temp_path("nested");
        let dest = temp_path("nested-out");
        create_flashnote_db(
            &source,
            &[
                (1, 0, 2, "Root B", "b", 0),
                (2, 0, 1, "Root A", "a", 0),
                (3, 2, 2, "Child 2", "c2", 0),
                (4, 2, 1, "Child 1", "c1", 0),
            ],
        );

        let summary = import_flashnote(&source, &dest, "C:/other/current.sqlite3").expect("import");
        assert_eq!(summary.notes_imported, 4);
        assert_eq!(summary.notes_skipped, 0);

        let rows = read_treenote_rows(&dest);
        assert_eq!(rows.len(), 4);
        let roots: Vec<_> = rows
            .iter()
            .filter(|(parent, _, _, _)| parent.is_none())
            .map(|(_, label, sort_order, _)| (label.as_str(), *sort_order))
            .collect();
        assert_eq!(roots, vec![("Root A", 0), ("Root B", 1)]);

        let root_a_id = rows
            .iter()
            .find(|(_, label, _, _)| label == "Root A")
            .and_then(|(parent, _, _, _)| parent.clone());
        assert!(root_a_id.is_none());

        let child_labels: Vec<_> = rows
            .iter()
            .filter(|(parent, label, _, _)| parent.is_some() && label.starts_with("Child"))
            .map(|(_, label, sort_order, _)| (label.as_str(), *sort_order))
            .collect();
        assert_eq!(child_labels, vec![("Child 1", 0), ("Child 2", 1)]);

        let ids: HashSet<String> = conn_ids(&dest);
        assert_eq!(ids.len(), 4);

        let _ = fs::remove_file(source);
        let _ = fs::remove_file(dest);
    }

    fn conn_ids(path: &Path) -> HashSet<String> {
        let conn = Connection::open(path).expect("open");
        let mut stmt = conn
            .prepare("SELECT id FROM notes")
            .expect("prepare ids");
        stmt.query_map([], |row| row.get::<_, String>(0))
            .expect("query ids")
            .filter_map(Result::ok)
            .collect()
    }

    #[test]
    fn skips_trash_and_descendants() {
        let source = temp_path("trash");
        let dest = temp_path("trash-out");
        create_flashnote_db(
            &source,
            &[
                (1, 0, 1, "Keep", "ok", 0),
                (2, 0, 2, "Trash root", "gone", 1),
                (3, 2, 1, "Trash child", "gone too", 0),
            ],
        );

        let summary = import_flashnote(&source, &dest, "C:/other/current.sqlite3").expect("import");
        assert_eq!(summary.notes_imported, 1);
        assert_eq!(summary.notes_skipped, 2);
        let rows = read_treenote_rows(&dest);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1, "Keep");

        let _ = fs::remove_file(source);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn empty_name_becomes_untitled() {
        let source = temp_path("untitled");
        let dest = temp_path("untitled-out");
        create_flashnote_db(&source, &[(1, 0, 1, "   ", "body", 0)]);

        import_flashnote(&source, &dest, "C:/other/current.sqlite3").expect("import");
        let rows = read_treenote_rows(&dest);
        assert_eq!(rows[0].1, "Untitled");

        let _ = fs::remove_file(source);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn duplicate_folderpos_still_orders_deterministically() {
        let source = temp_path("dup-folderpos");
        let dest = temp_path("dup-folderpos-out");
        create_flashnote_db(
            &source,
            &[
                (10, 0, 1, "Second", "b", 0),
                (11, 0, 1, "First", "a", 0),
            ],
        );

        import_flashnote(&source, &dest, "C:/other/current.sqlite3").expect("import");
        let rows = read_treenote_rows(&dest);
        let labels: Vec<_> = rows.iter().map(|(_, label, _, _)| label.as_str()).collect();
        assert_eq!(labels, vec!["Second", "First"]);

        let _ = fs::remove_file(source);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn orphan_rows_become_roots() {
        let source = temp_path("orphan");
        let dest = temp_path("orphan-out");
        create_flashnote_db(
            &source,
            &[
                (1, 0, 1, "Root", "root", 0),
                (2, 99, 1, "Orphan", "orphan", 0),
            ],
        );

        import_flashnote(&source, &dest, "C:/other/current.sqlite3").expect("import");
        let rows = read_treenote_rows(&dest);
        let roots = rows
            .iter()
            .filter(|(parent, _, _, _)| parent.is_none())
            .count();
        assert_eq!(roots, 2);

        let _ = fs::remove_file(source);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn rejects_destination_that_exists() {
        let source = temp_path("exists-src");
        let dest = temp_path("exists-dest");
        create_flashnote_db(&source, &[(1, 0, 1, "Root", "x", 0)]);
        fs::write(&dest, "already there").expect("write dest");

        let err = import_flashnote(&source, &dest, "C:/other/current.sqlite3")
            .expect_err("should reject existing dest");
        assert!(err.contains("already exists"));

        let _ = fs::remove_file(source);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn rejects_destination_equal_to_current_notebook() {
        let source = temp_path("current-src");
        let dest = temp_path("current-dest");
        create_flashnote_db(&source, &[(1, 0, 1, "Root", "x", 0)]);

        let err = import_flashnote(&source, &dest, dest.to_string_lossy().as_ref())
            .expect_err("should reject current notebook");
        assert!(err.contains("currently open"));

        let _ = fs::remove_file(source);
    }

    #[test]
    fn rejects_missing_notes3_table() {
        let source = temp_path("missing-table");
        let dest = temp_path("missing-table-out");
        let conn = Connection::open(&source).expect("open");
        conn.execute("CREATE TABLE other(id INTEGER PRIMARY KEY)", [])
            .expect("schema");

        let err = import_flashnote(&source, &dest, "C:/other/current.sqlite3")
            .expect_err("should reject");
        assert!(err.contains("notes3"));

        let _ = fs::remove_file(source);
    }

    #[test]
    fn strips_rtf_prefix_to_plain_text() {
        let source = temp_path("rtf");
        let dest = temp_path("rtf-out");
        create_flashnote_db(
            &source,
            &[(
                1,
                0,
                1,
                "RTF note",
                "{\\rtf1\\ansi Hello\\par World}",
                0,
            )],
        );

        import_flashnote(&source, &dest, "C:/other/current.sqlite3").expect("import");
        let rows = read_treenote_rows(&dest);
        assert!(rows[0].3.contains("Hello"));
        assert!(rows[0].3.contains("World"));

        let _ = fs::remove_file(source);
        let _ = fs::remove_file(dest);
    }

    fn create_treenote_db(path: &Path, rows: &[(&str, Option<&str>, &str, i64, &str)]) {
        if path.exists() {
            fs::remove_file(path).expect("remove old db");
        }
        let conn = Connection::open(path).expect("open treenote db");
        conn.execute_batch(CREATE_NOTES_TABLE_SQL)
            .expect("schema");
        for (id, parent_id, label, sort_order, content) in rows {
            conn.execute(
                "INSERT INTO notes (id, parent_id, label, is_expanded, sort_order, content) \
                 VALUES (?1, ?2, ?3, 1, ?4, ?5)",
                params![id, parent_id, label, sort_order, content],
            )
            .expect("insert");
        }
    }

    fn read_flashnote_rows(path: &Path) -> Vec<(i64, i64, i64, String, String)> {
        let conn = Connection::open(path).expect("open flashnote db");
        let mut stmt = conn
            .prepare(
                "SELECT id, pid, folderpos, name, note FROM notes3 ORDER BY pid, folderpos, id",
            )
            .expect("prepare");
        stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .expect("query")
        .filter_map(Result::ok)
        .collect()
    }

    fn treenote_notes(rows: &[(&str, Option<&str>, &str, i64, &str)]) -> Vec<TreenoteNote> {
        rows.iter()
            .map(|(id, parent_id, label, sort_order, content)| TreenoteNote {
                id: (*id).to_string(),
                parent_id: parent_id.map(|value| value.to_string()),
                label: (*label).to_string(),
                sort_order: *sort_order,
                content: (*content).to_string(),
            })
            .collect()
    }

    #[test]
    fn exports_nested_tree_with_folderpos_order() {
        let source = temp_path("export-source");
        let dest = temp_path("export-dest");
        create_treenote_db(
            &source,
            &[
                ("root-b", None, "Root B", 1, "b"),
                ("root-a", None, "Root A", 0, "a"),
                ("child-2", Some("root-a"), "Child 2", 1, "c2"),
                ("child-1", Some("root-a"), "Child 1", 0, "c1"),
            ],
        );

        let notes = treenote_notes(&[
            ("root-b", None, "Root B", 1, "b"),
            ("root-a", None, "Root A", 0, "a"),
            ("child-2", Some("root-a"), "Child 2", 1, "c2"),
            ("child-1", Some("root-a"), "Child 1", 0, "c1"),
        ]);
        let summary = export_flashnote(&dest, &notes).expect("export");
        assert_eq!(summary.notes_exported, 4);

        let rows = read_flashnote_rows(&dest);
        assert_eq!(rows.len(), 4);
        let roots: Vec<_> = rows
            .iter()
            .filter(|(_, pid, _, _, _)| *pid == 0)
            .map(|(_, _, folderpos, name, _)| (*folderpos, name.as_str()))
            .collect();
        assert_eq!(roots, vec![(1, "Root A"), (2, "Root B")]);

        let _ = fs::remove_file(source);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn export_round_trips_through_import() {
        let treenote_source = temp_path("roundtrip-source");
        let flashnote_dest = temp_path("roundtrip-flash");
        let treenote_dest = temp_path("roundtrip-treenote");
        create_treenote_db(
            &treenote_source,
            &[
                ("root", None, "Root", 0, "root body"),
                ("child", Some("root"), "Child", 0, "child body"),
            ],
        );

        let notes = treenote_notes(&[
            ("root", None, "Root", 0, "root body"),
            ("child", Some("root"), "Child", 0, "child body"),
        ]);
        export_flashnote(&flashnote_dest, &notes).expect("export");
        let summary = import_flashnote(&flashnote_dest, &treenote_dest, "C:/other/current.sqlite3")
            .expect("import");
        assert_eq!(summary.notes_imported, 2);

        let rows = read_treenote_rows(&treenote_dest);
        assert_eq!(rows.len(), 2);
        let labels: Vec<_> = rows.iter().map(|(_, label, _, _)| label.as_str()).collect();
        assert!(labels.contains(&"Root"));
        assert!(labels.contains(&"Child"));

        let _ = fs::remove_file(treenote_source);
        let _ = fs::remove_file(flashnote_dest);
        let _ = fs::remove_file(treenote_dest);
    }

    #[test]
    fn rejects_export_when_destination_exists() {
        let dest = temp_path("export-exists");
        fs::write(&dest, "exists").expect("write dest");
        let notes = treenote_notes(&[("root", None, "Root", 0, "body")]);
        let err = export_flashnote(&dest, &notes).expect_err("should reject");
        assert!(err.contains("already exists"));
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn rejects_export_when_notebook_is_empty() {
        let dest = temp_path("export-empty");
        let err = export_flashnote(&dest, &[]).expect_err("should reject empty");
        assert!(err.contains("No notes"));
    }
}
