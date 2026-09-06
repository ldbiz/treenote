use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreenoteJsonNode {
    pub id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub label: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default)]
    pub is_expanded: Option<bool>,
    #[serde(default)]
    pub children: Vec<TreenoteJsonNode>,
}

#[derive(Debug, Clone)]
struct FlatNoteRow {
    id: String,
    parent_id: Option<String>,
    label: String,
    content: String,
    sort_order: i64,
    is_expanded: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ImportSummary {
    pub notes_imported: usize,
    pub dest_path: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ExportSummary {
    pub notes_exported: usize,
    pub dest_path: String,
}

pub fn build_tree_from_connection(conn: &Connection) -> Result<Vec<TreenoteJsonNode>, String> {
    build_export_nodes(conn, None).map_err(|e| e.to_string())
}

pub fn export_treenote_json(
    dest_path: &Path,
    nodes: &[TreenoteJsonNode],
) -> Result<ExportSummary, String> {
    if dest_path.exists() {
        return Err(format!(
            "A file already exists at {}. Choose a different location.",
            dest_path.display()
        ));
    }

    let notes_exported = count_nodes(nodes);
    if notes_exported == 0 {
        return Err("No notes to export.".into());
    }

    let parent = dest_path
        .parent()
        .ok_or_else(|| "Invalid destination path.".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let temp_path = parent.join(format!(
        ".treenote-json-export-{}.partial",
        Uuid::new_v4()
    ));

    let write_result = fs::write(
        &temp_path,
        serde_json::to_string_pretty(nodes).map_err(|e| e.to_string())?,
    );
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error.to_string());
    }

    fs::rename(&temp_path, dest_path).map_err(|e| {
        let _ = fs::remove_file(&temp_path);
        format!("Failed to create JSON export: {}", e)
    })?;

    Ok(ExportSummary {
        notes_exported,
        dest_path: dest_path.to_string_lossy().to_string(),
    })
}

pub fn import_treenote_json(
    source_path: &Path,
    dest_path: &Path,
    current_database_path: &str,
) -> Result<ImportSummary, String> {
    if !source_path.is_file() {
        return Err(format!(
            "TreeNote JSON file not found: {}",
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

    let content = fs::read_to_string(source_path).map_err(|e| e.to_string())?;
    let roots: Vec<TreenoteJsonNode> =
        serde_json::from_str(&content).map_err(|_| {
            "This file is not TreeNote-formatted JSON.".to_string()
        })?;

    validate_root_nodes(&roots)?;

    let mut flat_rows = Vec::new();
    for (index, root) in roots.iter().enumerate() {
        flatten_node(root, None, index as i64, &mut flat_rows);
    }

    if flat_rows.is_empty() {
        return Err("No importable notes were found in the JSON file.".into());
    }

    let parent = dest_path
        .parent()
        .ok_or_else(|| "Invalid destination path.".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let temp_path = parent.join(format!(
        ".treenote-json-import-{}.partial",
        Uuid::new_v4()
    ));

    let import_result = write_treenote_notebook(&temp_path, &flat_rows);
    if let Err(error) = import_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    fs::rename(&temp_path, dest_path).map_err(|e| {
        let _ = fs::remove_file(&temp_path);
        format!("Failed to create notebook: {}", e)
    })?;

    Ok(ImportSummary {
        notes_imported: flat_rows.len(),
        dest_path: dest_path.to_string_lossy().to_string(),
    })
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn count_nodes(nodes: &[TreenoteJsonNode]) -> usize {
    nodes
        .iter()
        .map(|node| 1 + count_nodes(&node.children))
        .sum()
}

fn build_export_nodes(
    conn: &Connection,
    parent_id: Option<&str>,
) -> rusqlite::Result<Vec<TreenoteJsonNode>> {
    let mut stmt = conn.prepare(
        "SELECT id, parent_id, label, COALESCE(content,''), sort_order, is_expanded \
         FROM notes WHERE parent_id IS ?1 ORDER BY sort_order ASC",
    )?;
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
    for row in rows {
        let (id, parent_id, label, content, sort_order, expanded) = row?;
        let children = build_export_nodes(conn, Some(&id))?;
        out.push(TreenoteJsonNode {
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

fn validate_root_nodes(roots: &[TreenoteJsonNode]) -> Result<(), String> {
    if roots.is_empty() {
        return Err("TreeNote-formatted JSON must be a non-empty array of notes.".into());
    }

    let mut seen_ids = HashSet::new();
    fn visit(node: &TreenoteJsonNode, seen_ids: &mut HashSet<String>) -> Result<(), String> {
        if node.id.trim().is_empty() {
            return Err("TreeNote-formatted JSON contains a note without an id.".into());
        }
        if !seen_ids.insert(node.id.clone()) {
            return Err("TreeNote-formatted JSON contains duplicate note ids.".into());
        }
        for child in &node.children {
            visit(child, seen_ids)?;
        }
        Ok(())
    }

    for root in roots {
        visit(root, &mut seen_ids)?;
    }
    Ok(())
}

fn flatten_node(
    node: &TreenoteJsonNode,
    parent_id: Option<String>,
    sort_order: i64,
    out: &mut Vec<FlatNoteRow>,
) {
    out.push(FlatNoteRow {
        id: node.id.clone(),
        parent_id,
        label: label_from_json(&node.label),
        content: node.content.clone(),
        sort_order,
        is_expanded: node.is_expanded,
    });
    for (index, child) in node.children.iter().enumerate() {
        flatten_node(child, Some(node.id.clone()), index as i64, out);
    }
}

fn label_from_json(label: &str) -> String {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

fn write_treenote_notebook(dest_path: &Path, rows: &[FlatNoteRow]) -> Result<(), String> {
    let known_ids: HashSet<String> = rows.iter().map(|row| row.id.clone()).collect();
    let conn = Connection::open(dest_path).map_err(|e| e.to_string())?;
    conn.execute_batch(CREATE_NOTES_TABLE_SQL)
        .map_err(|e| e.to_string())?;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for row in rows {
        let parent_id = match &row.parent_id {
            None => None,
            Some(parent) if known_ids.contains(parent) => Some(parent.clone()),
            Some(_) => None,
        };
        let is_expanded = row.is_expanded.map(|v| if v { 1 } else { 0 }).unwrap_or(1);
        tx.execute(
            "INSERT INTO notes (id, parent_id, label, is_expanded, sort_order, content) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                row.id,
                parent_id,
                row.label,
                is_expanded,
                row.sort_order,
                row.content,
            ],
        )
        .map_err(|e| e.to_string())?;
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
        std::env::temp_dir().join(format!("treenote-json-test-{name}-{nanos}"))
    }

    fn sample_tree() -> Vec<TreenoteJsonNode> {
        vec![
            TreenoteJsonNode {
                id: "root-b".into(),
                parent_id: None,
                label: "Root B".into(),
                content: "b".into(),
                sort_order: 1,
                is_expanded: Some(true),
                children: vec![],
            },
            TreenoteJsonNode {
                id: "root-a".into(),
                parent_id: None,
                label: "Root A".into(),
                content: "a".into(),
                sort_order: 0,
                is_expanded: Some(true),
                children: vec![
                    TreenoteJsonNode {
                        id: "child-1".into(),
                        parent_id: Some("root-a".into()),
                        label: "Child 1".into(),
                        content: "c1".into(),
                        sort_order: 0,
                        is_expanded: Some(true),
                        children: vec![],
                    },
                    TreenoteJsonNode {
                        id: "child-2".into(),
                        parent_id: Some("root-a".into()),
                        label: "Child 2".into(),
                        content: "c2".into(),
                        sort_order: 1,
                        is_expanded: Some(true),
                        children: vec![],
                    },
                ],
            },
        ]
    }

    fn read_treenote_rows(path: &Path) -> Vec<(Option<String>, String, i64, String)> {
        let conn = Connection::open(path).expect("open");
        let mut stmt = conn
            .prepare(
                "SELECT parent_id, label, sort_order, content FROM notes \
                 ORDER BY COALESCE(parent_id, ''), sort_order, label",
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
    fn exports_and_imports_nested_tree() {
        let json_path = temp_path("export.json");
        let notebook_path = temp_path("import.sqlite3");
        let tree = sample_tree();

        let summary = export_treenote_json(&json_path, &tree).expect("export");
        assert_eq!(summary.notes_exported, 4);

        let import_summary =
            import_treenote_json(&json_path, &notebook_path, "C:/other/current.sqlite3")
                .expect("import");
        assert_eq!(import_summary.notes_imported, 4);

        let rows = read_treenote_rows(&notebook_path);
        assert_eq!(rows.len(), 4);
        let roots = rows
            .iter()
            .filter(|(parent, _, _, _)| parent.is_none())
            .count();
        assert_eq!(roots, 2);

        let _ = fs::remove_file(json_path);
        let _ = fs::remove_file(notebook_path);
    }

    #[test]
    fn empty_label_becomes_untitled_on_import() {
        let json_path = temp_path("untitled.json");
        let notebook_path = temp_path("untitled.sqlite3");
        let tree = vec![TreenoteJsonNode {
            id: "root".into(),
            parent_id: None,
            label: "   ".into(),
            content: "body".into(),
            sort_order: 0,
            is_expanded: None,
            children: vec![],
        }];
        export_treenote_json(&json_path, &tree).expect("export");
        import_treenote_json(&json_path, &notebook_path, "C:/other/current.sqlite3")
            .expect("import");
        let rows = read_treenote_rows(&notebook_path);
        assert_eq!(rows[0].1, "Untitled");

        let _ = fs::remove_file(json_path);
        let _ = fs::remove_file(notebook_path);
    }

    #[test]
    fn rejects_invalid_json_shape() {
        let json_path = temp_path("invalid.json");
        let notebook_path = temp_path("invalid.sqlite3");
        fs::write(&json_path, r#"{"not":"an array"}"#).expect("write");

        let err = import_treenote_json(&json_path, &notebook_path, "C:/other/current.sqlite3")
            .expect_err("reject");
        assert!(err.contains("TreeNote-formatted JSON"));

        let _ = fs::remove_file(json_path);
    }

    #[test]
    fn rejects_destination_that_exists() {
        let json_path = temp_path("exists.json");
        let dest = temp_path("exists.sqlite3");
        export_treenote_json(&json_path, &sample_tree()).expect("export");
        fs::write(&dest, "exists").expect("write dest");

        let err = import_treenote_json(&json_path, &dest, "C:/other/current.sqlite3")
            .expect_err("reject");
        assert!(err.contains("already exists"));

        let _ = fs::remove_file(json_path);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn rejects_destination_equal_to_current_notebook() {
        let json_path = temp_path("current.json");
        let dest = temp_path("current.sqlite3");
        export_treenote_json(&json_path, &sample_tree()).expect("export");

        let err = import_treenote_json(&json_path, &dest, dest.to_string_lossy().as_ref())
            .expect_err("reject");
        assert!(err.contains("currently open"));

        let _ = fs::remove_file(json_path);
    }

    #[test]
    fn round_trip_through_export_tree_builder() {
        let notebook_path = temp_path("builder.sqlite3");
        let conn = Connection::open(&notebook_path).expect("open");
        conn.execute_batch(CREATE_NOTES_TABLE_SQL).expect("schema");
        conn.execute(
            "INSERT INTO notes (id, parent_id, label, is_expanded, sort_order, content) \
             VALUES ('root', NULL, 'Root', 1, 0, 'root body')",
            [],
        )
        .expect("insert root");
        conn.execute(
            "INSERT INTO notes (id, parent_id, label, is_expanded, sort_order, content) \
             VALUES ('child', 'root', 'Child', 1, 0, 'child body')",
            [],
        )
        .expect("insert child");

        let tree = build_tree_from_connection(&conn).expect("build");
        assert_eq!(count_nodes(&tree), 2);

        let json_path = temp_path("roundtrip.json");
        let imported_path = temp_path("roundtrip.sqlite3");
        export_treenote_json(&json_path, &tree).expect("export");
        import_treenote_json(&json_path, &imported_path, "C:/other/current.sqlite3")
            .expect("import");

        let rows = read_treenote_rows(&imported_path);
        assert_eq!(rows.len(), 2);

        let _ = fs::remove_file(notebook_path);
        let _ = fs::remove_file(json_path);
        let _ = fs::remove_file(imported_path);
    }
}
