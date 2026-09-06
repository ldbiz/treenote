use super::markdown_tree::{
    import_markdown_tree, validate_import_directory, ImportSummary, MarkdownImportOptions,
};
use std::path::Path;

const SKIP_DIRS: &[&str] = &["_resources"];

pub fn import_joplin(
    source_path: &Path,
    dest_path: &Path,
    current_database_path: &str,
) -> Result<ImportSummary, String> {
    validate_import_directory(
        source_path,
        "Joplin export not found",
        "Selected path is not a directory",
        "Cannot import through a symlink. Select the target directory instead.",
    )?;

    let options = MarkdownImportOptions {
        skip_directory_names: SKIP_DIRS,
        title_from_front_matter: true,
        convert_obsidian_wikilinks: false,
    };

    import_markdown_tree(
        source_path,
        dest_path,
        current_database_path,
        &options,
        "No importable notes were found in the Joplin export.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("treenote-joplin-test-{name}-{nanos}"));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn temp_db(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        std::env::temp_dir().join(format!("treenote-joplin-test-{name}-{nanos}.sqlite3"))
    }

    fn read_rows(path: &Path) -> Vec<(Option<String>, String, String)> {
        let conn = Connection::open(path).expect("open");
        let mut stmt = conn
            .prepare(
                "SELECT parent_id, label, content FROM notes \
                 ORDER BY COALESCE(parent_id, ''), label",
            )
            .expect("prepare");
        stmt.query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .expect("query")
        .filter_map(Result::ok)
        .collect()
    }

    #[test]
    fn plain_markdown_export() {
        let root = temp_dir("plain");
        fs::create_dir_all(root.join("Notebook")).expect("mkdir");
        fs::write(root.join("Notebook/Note.md"), "body").expect("write");
        let dest = temp_db("plain-out");
        let summary = import_joplin(&root, &dest, "C:/other/current.sqlite3").expect("import");
        assert_eq!(summary.notes_imported, 2);
        let rows = read_rows(&dest);
        assert!(rows.iter().any(|(p, l, _)| p.is_none() && l == "Notebook"));
        assert!(rows.iter().any(|(_, l, c)| l == "Note" && c == "body"));
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn front_matter_title_overrides_filename() {
        let root = temp_dir("fm");
        fs::write(
            root.join("uuid.md"),
            "---\ntitle: Display Title\ncreated: 2020-01-01\n---\n\nBody",
        )
        .expect("write");
        let dest = temp_db("fm-out");
        import_joplin(&root, &dest, "C:/other/current.sqlite3").expect("import");
        let rows = read_rows(&dest);
        assert_eq!(rows[0].1, "Display Title");
        assert_eq!(rows[0].2.trim(), "Body");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn invalid_title_falls_back_to_filename() {
        let root = temp_dir("fallback");
        fs::write(root.join("Stem.md"), "---\ntitle: 42\n---\n\nBody").expect("write");
        let dest = temp_db("fallback-out");
        import_joplin(&root, &dest, "C:/other/current.sqlite3").expect("import");
        let rows = read_rows(&dest);
        assert_eq!(rows[0].1, "Stem");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn malformed_yaml_falls_back() {
        let root = temp_dir("bad-yaml");
        fs::write(root.join("Stem.md"), "---\n: bad\n---\n\nBody").expect("write");
        let dest = temp_db("bad-yaml-out");
        import_joplin(&root, &dest, "C:/other/current.sqlite3").expect("import");
        let rows = read_rows(&dest);
        assert_eq!(rows[0].1, "Stem");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn resources_folder_ignored() {
        let root = temp_dir("resources");
        fs::create_dir_all(root.join("_resources")).expect("mkdir");
        fs::write(root.join("_resources/abc.png"), "bin").expect("write");
        let dest = temp_db("resources-out");
        let err = import_joplin(&root, &dest, "C:/other/current.sqlite3").expect_err("empty");
        assert!(err.contains("No importable notes"));
        assert!(!dest.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resources_markdown_attachment_is_ignored() {
        let root = temp_dir("resources-md");
        fs::create_dir_all(root.join("_resources")).expect("mkdir");
        fs::write(root.join("_resources/attachment.md"), "attachment body").expect("write");
        fs::write(root.join("note.md"), "root body").expect("write");
        let dest = temp_db("resources-md-out");
        let summary = import_joplin(&root, &dest, "C:/other/current.sqlite3").expect("import");
        assert_eq!(summary.notes_imported, 1);
        let rows = read_rows(&dest);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1, "note");
        assert_eq!(rows[0].2, "root body");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn same_stem_note_and_folder_stay_unmerged() {
        let root = temp_dir("unmerged");
        fs::write(
            root.join("Note.md"),
            "---\ntitle: From Front Matter\n---\n\nNote body",
        )
        .expect("write");
        fs::create_dir_all(root.join("Note")).expect("mkdir");
        fs::write(root.join("Note/Child.md"), "child").expect("write");
        let dest = temp_db("unmerged-out");
        import_joplin(&root, &dest, "C:/other/current.sqlite3").expect("import");
        let rows = read_rows(&dest);
        let roots: Vec<_> = rows
            .iter()
            .filter(|(p, _, _)| p.is_none())
            .map(|(_, l, c)| (l.as_str(), c.as_str()))
            .collect();
        assert_eq!(roots.len(), 2);
        assert!(roots
            .iter()
            .any(|(l, c)| *l == "From Front Matter" && *c == "Note body"));
        assert!(roots.iter().any(|(l, c)| *l == "Note" && c.is_empty()));
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(dest);
    }
}
