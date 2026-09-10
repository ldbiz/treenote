use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::atomic_file;

pub const METADATA_FILENAME: &str = "backup-metadata.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct BackupMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default)]
    pub locked: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BackupIndex {
    pub entries: HashMap<String, BackupMeta>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IndexReadResult {
    Absent,
    Ok(BackupIndex),
    Unreadable(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockState {
    Known(HashSet<u64>),
    Unavailable,
}

fn metadata_path(dir: &Path) -> PathBuf {
    dir.join(METADATA_FILENAME)
}

fn timestamp_key(timestamp: u64) -> String {
    timestamp.to_string()
}

fn parse_timestamp_key(key: &str) -> Result<u64, String> {
    key.parse::<u64>()
        .map_err(|_| format!("Invalid backup metadata timestamp key: {key}"))
}

fn parse_index_json(content: &str) -> Result<BackupIndex, String> {
    let raw: HashMap<String, BackupMeta> =
        serde_json::from_str(content).map_err(|e| format!("Invalid backup metadata: {e}"))?;
    for key in raw.keys() {
        parse_timestamp_key(key)?;
    }
    Ok(BackupIndex { entries: raw })
}

pub fn read_index(dir: &Path) -> IndexReadResult {
    let path = metadata_path(dir);
    if !path.is_file() {
        return IndexReadResult::Absent;
    }
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            return IndexReadResult::Unreadable(format!(
                "Could not read {}: {e}",
                path.display()
            ));
        }
    };
    match parse_index_json(&content) {
        Ok(index) => IndexReadResult::Ok(index),
        Err(reason) => IndexReadResult::Unreadable(format!("{} ({reason})", path.display())),
    }
}

pub fn write_index(dir: &Path, index: &BackupIndex) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = metadata_path(dir);
    let json = serde_json::to_string_pretty(&index.entries).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(
        ".{}.tmp.{}",
        METADATA_FILENAME,
        Uuid::new_v4()
    ));
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    let result = atomic_file::atomic_replace_file(&tmp, &path);
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

pub fn lock_state_from_read(read: IndexReadResult) -> LockState {
    match read {
        IndexReadResult::Unreadable(reason) => {
            eprintln!("TreeNote backup metadata unavailable: {reason}");
            LockState::Unavailable
        }
        IndexReadResult::Absent => LockState::Known(HashSet::new()),
        IndexReadResult::Ok(index) => {
            let mut locked = HashSet::new();
            for (key, meta) in &index.entries {
                let Ok(timestamp) = parse_timestamp_key(key) else {
                    eprintln!(
                        "TreeNote backup metadata unavailable: invalid timestamp key {key}"
                    );
                    return LockState::Unavailable;
                };
                if meta.locked {
                    locked.insert(timestamp);
                }
            }
            LockState::Known(locked)
        }
    }
}

pub fn metadata_warning(read: IndexReadResult) -> Option<String> {
    match read {
        IndexReadResult::Unreadable(reason) => Some(format!(
            "Automatic backup cleanup is paused because {reason}. \
             Fix or remove that file to resume normal retention."
        )),
        _ => None,
    }
}

pub fn meta_for_timestamp(read: &IndexReadResult, timestamp: u64) -> BackupMeta {
    let IndexReadResult::Ok(index) = read else {
        return BackupMeta::default();
    };
    index
        .entries
        .get(&timestamp_key(timestamp))
        .cloned()
        .unwrap_or_default()
}

pub fn set_entry(
    dir: &Path,
    timestamp: u64,
    label: Option<String>,
    locked: bool,
) -> Result<(), String> {
    let read = read_index(dir);
    let mut index = match read {
        IndexReadResult::Absent => BackupIndex::default(),
        IndexReadResult::Ok(existing) => existing,
        IndexReadResult::Unreadable(reason) => {
            return Err(format!(
                "Could not update backup metadata because it is unreadable: {reason}"
            ));
        }
    };
    let trimmed = label.and_then(|value| {
        let t = value.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    if trimmed.is_none() && !locked {
        index.entries.remove(&timestamp_key(timestamp));
    } else {
        index.entries.insert(
            timestamp_key(timestamp),
            BackupMeta {
                label: trimmed,
                locked,
            },
        );
    }
    if index.entries.is_empty() {
        let path = metadata_path(dir);
        if path.is_file() {
            let _ = std::fs::remove_file(path);
        }
        return Ok(());
    }
    write_index(dir, &index)
}

pub fn set_lock(dir: &Path, timestamp: u64, locked: bool) -> Result<(), String> {
    let read = read_index(dir);
    let mut index = match read {
        IndexReadResult::Absent if !locked => return Ok(()),
        IndexReadResult::Absent => BackupIndex::default(),
        IndexReadResult::Ok(existing) => existing,
        IndexReadResult::Unreadable(reason) => {
            return Err(format!(
                "Could not update backup lock because metadata is unreadable: {reason}"
            ));
        }
    };
    let key = timestamp_key(timestamp);
    let entry = index.entries.entry(key).or_default();
    entry.locked = locked;
    if entry.label.is_none() && !entry.locked {
        index.entries.remove(&timestamp_key(timestamp));
    }
    if index.entries.is_empty() {
        let path = metadata_path(dir);
        if path.is_file() {
            let _ = std::fs::remove_file(path);
        }
        return Ok(());
    }
    write_index(dir, &index)
}

pub fn forget_missing(dir: &Path, existing_timestamps: &HashSet<u64>) -> Result<(), String> {
    let read = read_index(dir);
    let IndexReadResult::Ok(mut index) = read else {
        return Ok(());
    };
    if index
        .entries
        .keys()
        .any(|key| parse_timestamp_key(key).is_err())
    {
        return Ok(());
    }
    index.entries.retain(|key, _| {
        parse_timestamp_key(key)
            .ok()
            .map(|ts| existing_timestamps.contains(&ts))
            .unwrap_or(false)
    });
    if index.entries.is_empty() {
        let path = metadata_path(dir);
        if path.is_file() {
            let _ = std::fs::remove_file(path);
        }
        return Ok(());
    }
    write_index(dir, &index)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("treenote-meta-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn absent_index_yields_known_empty_lock_state() {
        let dir = temp_dir();
        assert_eq!(read_index(&dir), IndexReadResult::Absent);
        assert_eq!(
            lock_state_from_read(read_index(&dir)),
            LockState::Known(HashSet::new())
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn round_trip_label_and_lock() {
        let dir = temp_dir();
        set_entry(&dir, 1_700_000_000, Some("Before release".into()), true).expect("set");
        let read = read_index(&dir);
        let meta = meta_for_timestamp(&read, 1_700_000_000);
        assert_eq!(meta.label.as_deref(), Some("Before release"));
        assert!(meta.locked);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_json_is_unreadable_not_empty() {
        let dir = temp_dir();
        fs::write(metadata_path(&dir), "{").expect("write corrupt");
        assert!(matches!(read_index(&dir), IndexReadResult::Unreadable(_)));
        assert_eq!(
            lock_state_from_read(read_index(&dir)),
            LockState::Unavailable
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_shape_json_is_unreadable() {
        let dir = temp_dir();
        fs::write(metadata_path(&dir), r#""not-an-object""#).expect("write");
        assert!(matches!(read_index(&dir), IndexReadResult::Unreadable(_)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn forget_missing_drops_locked_entries_without_files() {
        let dir = temp_dir();
        set_entry(&dir, 1_700_000_000, Some("kept label".into()), true).expect("set");
        set_entry(&dir, 1_700_000_100, Some("gone".into()), false).expect("set");
        forget_missing(&dir, &HashSet::from([1_700_000_000])).expect("forget");
        let read = read_index(&dir);
        assert!(meta_for_timestamp(&read, 1_700_000_000).locked);
        assert_eq!(
            meta_for_timestamp(&read, 1_700_000_100),
            BackupMeta::default()
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn labels_with_quotes_and_newlines_survive() {
        let dir = temp_dir();
        let label = "Line1\n\"quoted\"";
        set_entry(&dir, 42, Some(label.into()), false).expect("set");
        let read = read_index(&dir);
        assert_eq!(meta_for_timestamp(&read, 42).label.as_deref(), Some(label));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_entry_on_corrupt_index_fails_without_overwrite() {
        let dir = temp_dir();
        fs::write(metadata_path(&dir), "{").expect("write corrupt");
        let err = set_entry(&dir, 1, Some("label".into()), true).expect_err("must fail");
        assert!(err.contains("unreadable"));
        let content = fs::read_to_string(metadata_path(&dir)).expect("still corrupt");
        assert_eq!(content, "{");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_timestamp_key_is_unreadable() {
        let dir = temp_dir();
        fs::write(
            metadata_path(&dir),
            r#"{"not-a-timestamp":{"locked":true}}"#,
        )
        .expect("write");
        assert!(matches!(read_index(&dir), IndexReadResult::Unreadable(_)));
        assert_eq!(
            lock_state_from_read(read_index(&dir)),
            LockState::Unavailable
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn lock_state_from_hand_built_index_with_bad_key_is_unavailable() {
        let mut entries = HashMap::new();
        entries.insert(
            "bad-key".to_string(),
            BackupMeta {
                label: None,
                locked: true,
            },
        );
        assert_eq!(
            lock_state_from_read(IndexReadResult::Ok(BackupIndex { entries })),
            LockState::Unavailable
        );
    }

    #[test]
    fn forget_missing_leaves_malformed_on_disk_index_untouched() {
        let dir = temp_dir();
        let raw = r#"{"not-a-timestamp":{"locked":true}}"#;
        fs::write(metadata_path(&dir), raw).expect("write");
        forget_missing(&dir, &HashSet::new()).expect("forget");
        let content = fs::read_to_string(metadata_path(&dir)).expect("read");
        assert_eq!(content, raw);
        let _ = fs::remove_dir_all(&dir);
    }
}
