use fs4::{FileExt, TryLockError};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

pub const LOCK_CONFLICT_MESSAGE: &str = "This notebook is already open in another TreeNote window.";

const LOCK_SUFFIX: &str = ".treenote.lock";

#[derive(Debug)]
pub struct NotebookLock {
    _file: File,
    notebook_path: PathBuf,
}

impl NotebookLock {
    pub fn notebook_path(&self) -> &Path {
        &self.notebook_path
    }
}

fn companion_lock_path(notebook_path: &Path) -> PathBuf {
    let mut os_str = notebook_path.as_os_str().to_os_string();
    os_str.push(LOCK_SUFFIX);
    PathBuf::from(os_str)
}

pub fn normalize_notebook_path(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err("Notebook path is required".into());
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|_| "Could not resolve notebook path".to_string())?
            .join(path)
    };

    if absolute.exists() {
        return canonicalize_existing(&absolute);
    }

    let file_name = absolute
        .file_name()
        .ok_or_else(|| "Notebook path is required".to_string())?;
    let parent = absolute.parent().filter(|p| !p.as_os_str().is_empty());
    let parent = match parent {
        Some(p) => p.to_path_buf(),
        None => {
            std::env::current_dir().map_err(|_| "Could not resolve notebook path".to_string())?
        }
    };

    std::fs::create_dir_all(&parent)
        .map_err(|_| "Could not prepare notebook location".to_string())?;
    let canonical_parent = std::fs::canonicalize(&parent)
        .map_err(|_| "Could not resolve notebook path".to_string())?;
    Ok(strip_verbatim(canonical_parent).join(file_name))
}

pub fn canonicalize_existing(path: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| "Could not resolve notebook path".to_string())?;
    Ok(strip_verbatim(canonical))
}

pub fn try_acquire(path: &Path) -> Result<NotebookLock, String> {
    let notebook_path = normalize_notebook_path(path)?;
    let lock_path = companion_lock_path(&notebook_path);
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| "Could not prepare notebook location".to_string())?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|_| "Could not open this notebook".to_string())?;
    match FileExt::try_lock(&file) {
        Ok(()) => Ok(NotebookLock {
            _file: file,
            notebook_path,
        }),
        Err(TryLockError::WouldBlock) => Err(LOCK_CONFLICT_MESSAGE.to_string()),
        Err(TryLockError::Error(_)) => Err("Could not open this notebook".into()),
    }
}

fn strip_verbatim(path: PathBuf) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        if let Some(unc) = rest.strip_prefix("UNC\\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest);
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("treenote-lock-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn acquire_unlocked_notebook_succeeds() {
        let dir = temp_dir();
        let notebook = dir.join("notes.sqlite3");
        let lock = try_acquire(&notebook).expect("acquire");
        assert_eq!(
            lock.notebook_path(),
            normalize_notebook_path(&notebook).unwrap()
        );
        assert!(companion_lock_path(lock.notebook_path()).exists());
        drop(lock);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn second_exclusive_lock_fails_while_first_is_held() {
        let dir = temp_dir();
        let notebook = dir.join("notes.sqlite3");
        let first = try_acquire(&notebook).expect("first lock");
        let second = try_acquire(&notebook).expect_err("second lock");
        assert_eq!(second, LOCK_CONFLICT_MESSAGE);
        drop(first);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn different_notebooks_can_be_locked_together() {
        let dir = temp_dir();
        let a = dir.join("a.sqlite3");
        let b = dir.join("b.sqlite3");
        let lock_a = try_acquire(&a).expect("lock a");
        let lock_b = try_acquire(&b).expect("lock b");
        assert_ne!(lock_a.notebook_path(), lock_b.notebook_path());
        drop(lock_a);
        drop(lock_b);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn drop_releases_lock_but_leaves_companion_file() {
        let dir = temp_dir();
        let notebook = dir.join("notes.sqlite3");
        let lock = try_acquire(&notebook).expect("acquire");
        let companion = companion_lock_path(lock.notebook_path());
        assert!(companion.exists());
        drop(lock);
        assert!(companion.exists());
        let again = try_acquire(&notebook).expect("re-acquire");
        assert!(companion_lock_path(again.notebook_path()).exists());
        drop(again);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn equivalent_paths_share_lock_identity() {
        let dir = temp_dir();
        let notebook = dir.join("notes.sqlite3");
        let dotted = dir.join(".").join("notes.sqlite3");
        let first = try_acquire(&notebook).expect("acquire");
        let conflict = try_acquire(&dotted).expect_err("same notebook");
        assert_eq!(conflict, LOCK_CONFLICT_MESSAGE);
        assert_eq!(
            normalize_notebook_path(&notebook).unwrap(),
            normalize_notebook_path(&dotted).unwrap()
        );
        drop(first);
        let _ = fs::remove_dir_all(&dir);
    }
}
