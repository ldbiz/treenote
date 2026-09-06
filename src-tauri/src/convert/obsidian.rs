use super::markdown_tree::{
    import_markdown_tree, validate_import_directory, ImportSummary, MarkdownImportOptions,
};
use std::path::Path;

const SKIP_DIRS: &[&str] = &[".obsidian"];

pub fn import_obsidian(
    source_path: &Path,
    dest_path: &Path,
    current_database_path: &str,
) -> Result<ImportSummary, String> {
    validate_import_directory(
        source_path,
        "Obsidian vault not found",
        "Selected path is not a directory",
        "Cannot import through a symlink. Select the target directory instead.",
    )?;

    let options = MarkdownImportOptions {
        skip_directory_names: SKIP_DIRS,
        title_from_front_matter: false,
        convert_obsidian_wikilinks: true,
    };

    import_markdown_tree(
        source_path,
        dest_path,
        current_database_path,
        &options,
        "No importable notes were found in the Obsidian vault.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convert::markdown_tree;
    use rusqlite::Connection;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("treenote-obsidian-test-{name}-{nanos}"));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn temp_db(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        std::env::temp_dir().join(format!("treenote-obsidian-test-{name}-{nanos}.sqlite3"))
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
    fn nested_vault_import() {
        let root = temp_dir("vault");
        fs::create_dir_all(root.join("Projects")).expect("mkdir");
        fs::write(root.join("Welcome.md"), "welcome").expect("write");
        fs::write(root.join("Projects/Alpha.md"), "alpha").expect("write");
        let dest = temp_db("vault-out");
        let summary = import_obsidian(&root, &dest, "C:/other/current.sqlite3").expect("import");
        assert_eq!(summary.notes_imported, 3);
        let rows = read_rows(&dest);
        assert!(rows
            .iter()
            .any(|(p, l, c)| p.is_none() && l == "Welcome" && c == "welcome"));
        assert!(rows.iter().any(|(p, l, _)| p.is_none() && l == "Projects"));
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn ignores_obsidian_directory() {
        let root = temp_dir("dot-obsidian");
        fs::create_dir_all(root.join(".obsidian")).expect("mkdir");
        fs::write(root.join(".obsidian/config.md"), "secret").expect("write");
        fs::write(root.join("note.md"), "ok").expect("write");
        let dest = temp_db("dot-obsidian-out");
        let summary = import_obsidian(&root, &dest, "C:/other/current.sqlite3").expect("import");
        assert_eq!(summary.notes_imported, 1);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn yaml_title_does_not_override_filename() {
        let root = temp_dir("yaml-title");
        fs::write(root.join("Stem.md"), "---\ntitle: Other\n---\n\nBody").expect("write");
        let dest = temp_db("yaml-title-out");
        import_obsidian(&root, &dest, "C:/other/current.sqlite3").expect("import");
        let rows = read_rows(&dest);
        assert_eq!(rows[0].1, "Stem");
        assert_eq!(rows[0].2.trim(), "Body");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn empty_vault_fails_without_notebook() {
        let root = temp_dir("empty");
        fs::create_dir_all(root.join(".obsidian")).expect("mkdir");
        let dest = temp_db("empty-out");
        let err = import_obsidian(&root, &dest, "C:/other/current.sqlite3").expect_err("empty");
        assert!(err.contains("No importable notes"));
        assert!(!dest.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn embed_does_not_import_binary_name() {
        let root = temp_dir("embed");
        fs::write(root.join("note.md"), "![[photo.png]]").expect("write");
        let dest = temp_db("embed-out");
        import_obsidian(&root, &dest, "C:/other/current.sqlite3").expect("import");
        let rows = read_rows(&dest);
        assert!(!rows[0].2.contains("photo.png"));
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn wiki_link_cases() {
        assert!(markdown_tree::markdown_to_plain_text("[[Page]]", true).contains("Page"));
        assert!(
            markdown_tree::markdown_to_plain_text("[[Page|Display]]", true).contains("Display")
        );
        assert!(
            markdown_tree::markdown_to_plain_text("[[Page#Heading]]", true)
                .contains("Page#Heading")
        );
        assert!(markdown_tree::markdown_to_plain_text("[[Page#Heading|X]]", true).contains("X"));
        assert_eq!(
            markdown_tree::markdown_to_plain_text("[[photo.png]]", true).trim(),
            "photo.png"
        );
        assert_eq!(
            markdown_tree::markdown_to_plain_text("![A nice photo](photo.png)", true).trim(),
            "A nice photo"
        );
    }
}
