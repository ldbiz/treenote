use std::path::{Component, Path, PathBuf};

use crate::data_root::DEFAULT_NOTEBOOK_FILENAME;
use crate::notebook_lock;

const SQLITE3_EXT: &str = "sqlite3";

const RESERVED_DEVICE_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "COM¹", "COM²",
    "COM³", "LPT¹", "LPT²", "LPT³",
];

fn is_reserved_device_base_name(name: &str) -> bool {
    RESERVED_DEVICE_NAMES
        .iter()
        .any(|reserved| name.eq_ignore_ascii_case(reserved))
}

fn reserved_device_base_name(stem: &str) -> &str {
    stem.split('.').next().unwrap_or(stem)
}

pub fn validate_notebook_name(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    let stem = if trimmed.len() > SQLITE3_EXT.len() + 1
        && trimmed
            .get(trimmed.len() - (SQLITE3_EXT.len() + 1)..)
            .is_some_and(|suffix| suffix.eq_ignore_ascii_case(&format!(".{SQLITE3_EXT}")))
    {
        &trimmed[..trimmed.len() - (SQLITE3_EXT.len() + 1)]
    } else {
        trimmed
    };
    let stem = stem.trim();
    if stem.is_empty() {
        return Err("Notebook name is required.".into());
    }
    if stem.ends_with(' ') || stem.ends_with('.') {
        return Err("Invalid notebook name.".into());
    }
    if stem.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control())
    {
        return Err("Invalid notebook name.".into());
    }
    let path = Path::new(stem);
    if path.components().count() != 1 {
        return Err("Invalid notebook name.".into());
    }
    match path.components().next() {
        Some(Component::Normal(part)) if part == stem => {}
        _ => return Err("Invalid notebook name.".into()),
    }
    if stem == "." || stem == ".." || stem.contains("..") {
        return Err("Invalid notebook name.".into());
    }
    if is_reserved_device_base_name(reserved_device_base_name(stem)) {
        return Err("Invalid notebook name.".into());
    }
    Ok(format!("{stem}.{SQLITE3_EXT}"))
}

pub fn require_managed_notebook(
    notebooks_dir: &Path,
    candidate: &Path,
) -> Result<PathBuf, String> {
    if !notebooks_dir.exists() {
        return Err("That file is not a TreeNote notebook in the data folder.".into());
    }
    if !candidate.exists() {
        return Err("Selected notebook does not exist.".into());
    }
    let canonical_dir = notebook_lock::canonicalize_existing(notebooks_dir)?;
    let canonical_file = notebook_lock::normalize_notebook_path(candidate)?;
    let extension = canonical_file
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("");
    if !extension.eq_ignore_ascii_case(SQLITE3_EXT) {
        return Err("That file is not a TreeNote notebook in the data folder.".into());
    }
    let parent = canonical_file
        .parent()
        .ok_or_else(|| "That file is not a TreeNote notebook in the data folder.".to_string())?;
    if parent != canonical_dir.as_path() {
        return Err("That file is not a TreeNote notebook in the data folder.".into());
    }
    Ok(canonical_file)
}

pub fn resolve_new_managed_notebook_path(
    notebooks_dir: &Path,
    name: &str,
) -> Result<PathBuf, String> {
    let filename = validate_notebook_name(name)?;
    std::fs::create_dir_all(notebooks_dir).map_err(|e| e.to_string())?;
    let canonical_dir = notebook_lock::canonicalize_existing(notebooks_dir)?;
    Ok(canonical_dir.join(filename))
}

pub fn require_new_managed_notebook_location(
    notebooks_dir: &Path,
    selected: &Path,
) -> Result<PathBuf, String> {
    let filename = selected
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Notebook name is required.".to_string())?;
    let dest = resolve_new_managed_notebook_path(notebooks_dir, filename)?;
    let parent = selected
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| {
            "That file is not a TreeNote notebook in the data folder.".to_string()
        })?;
    if !parent.exists() {
        return Err("That file is not a TreeNote notebook in the data folder.".into());
    }
    let canonical_parent = notebook_lock::canonicalize_existing(parent)?;
    let canonical_dir = notebook_lock::canonicalize_existing(notebooks_dir)?;
    if canonical_parent != canonical_dir {
        return Err("That file is not a TreeNote notebook in the data folder.".into());
    }
    Ok(dest)
}

pub fn is_default_notebook_filename(name: &str) -> bool {
    name.eq_ignore_ascii_case(DEFAULT_NOTEBOOK_FILENAME)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::fs;
    use uuid::Uuid;

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("treenote-managed-{}", Uuid::new_v4()));
        fs::create_dir_all(dir.join("notebooks")).expect("notebooks dir");
        dir
    }

    fn write_sqlite(path: &Path) {
        let _ = Connection::open(path).expect("sqlite");
    }

    #[test]
    fn name_validation_accepts_simple_names_and_optional_extension() {
        assert_eq!(validate_notebook_name("work").unwrap(), "work.sqlite3");
        assert_eq!(
            validate_notebook_name(" work.sqlite3 ").unwrap(),
            "work.sqlite3"
        );
        assert_eq!(
            validate_notebook_name("TreeNote").unwrap(),
            "TreeNote.sqlite3"
        );
    }

    #[test]
    fn name_validation_rejects_invalid_and_reserved_names() {
        assert!(validate_notebook_name("").is_err());
        assert!(validate_notebook_name("   ").is_err());
        assert!(validate_notebook_name("..").is_err());
        assert!(validate_notebook_name("../escape").is_err());
        assert!(validate_notebook_name("a/b").is_err());
        assert!(validate_notebook_name("a\\b").is_err());
        assert!(validate_notebook_name("bad:name").is_err());
        assert!(validate_notebook_name("con").is_err());
        assert!(validate_notebook_name("COM1").is_err());
        assert!(validate_notebook_name("aux.sqlite3").is_err());
        assert!(validate_notebook_name("notes.").is_err());
        assert!(validate_notebook_name("NUL.foo").is_err());
        assert!(validate_notebook_name("CON.notes").is_err());
        assert!(validate_notebook_name("COM1.archive").is_err());
        assert!(validate_notebook_name("COM¹.test").is_err());
        assert!(validate_notebook_name("work.notes").is_ok());
    }

    #[test]
    fn ordinary_direct_managed_file_is_accepted() {
        let root = temp_root();
        let notebooks = root.join("notebooks");
        let notebook = notebooks.join("work.sqlite3");
        write_sqlite(&notebook);
        let resolved = require_managed_notebook(&notebooks, &notebook).expect("managed");
        assert_eq!(resolved.file_name().unwrap(), "work.sqlite3");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn parent_dir_escape_is_rejected() {
        let root = temp_root();
        let notebooks = root.join("notebooks");
        let outside = root.join("escape.sqlite3");
        write_sqlite(&outside);
        let escaped = notebooks.join("..").join("escape.sqlite3");
        assert!(require_managed_notebook(&notebooks, &escaped).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn symlink_escape_is_rejected_when_platform_allows() {
        let root = temp_root();
        let notebooks = root.join("notebooks");
        let outside_dir = root.join("outside");
        fs::create_dir_all(&outside_dir).expect("outside");
        let target = outside_dir.join("escape.sqlite3");
        write_sqlite(&target);
        let link = notebooks.join("escape.sqlite3");
        let linked = create_file_symlink(&target, &link);
        if linked {
            assert!(require_managed_notebook(&notebooks, &link).is_err());
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn new_managed_location_rejects_parent_outside_notebooks() {
        let root = temp_root();
        let notebooks = root.join("notebooks");
        let outside = root.join("outside.sqlite3");
        assert!(require_new_managed_notebook_location(&notebooks, &outside).is_err());
        let inside = notebooks.join("work.sqlite3");
        let dest = require_new_managed_notebook_location(&notebooks, &inside).expect("inside");
        assert_eq!(dest.file_name().unwrap(), "work.sqlite3");
        let _ = fs::remove_dir_all(&root);
    }

    fn create_file_symlink(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link).is_ok()
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }
}
