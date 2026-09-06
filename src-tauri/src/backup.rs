use std::collections::HashSet;
use std::fmt::Write;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MANAGED_ROOT: &str = "TreeNote Backups";
pub const BACKUP_INTERVAL_SECS: u64 = 600;

const TEN_MIN: u64 = 600;
const HOUR: u64 = 3600;
const DAY: u64 = 86400;
const WEEK: u64 = 7 * DAY;
const MONTH: u64 = 30 * DAY;
const YEAR: u64 = 365 * DAY;

const BACKUP_FILENAME_PREFIX: &str = "treenote-backup-";
const BACKUP_FILENAME_SUFFIX: &str = ".sqlite3";

/// Rolling GFS retention: union of newest backup per slot across tiers.
pub fn backups_to_keep(timestamps: &[u64], now: u64) -> HashSet<u64> {
    let mut keep = HashSet::new();
    if timestamps.is_empty() {
        return keep;
    }

    // Ten-minute: last hour, 10-minute slots (ages 0..1h)
    for slot in 0..6 {
        let min_age = slot * TEN_MIN;
        let max_age = (slot + 1) * TEN_MIN;
        if let Some(ts) = newest_in_age_range(timestamps, now, min_age, max_age) {
            keep.insert(ts);
        }
    }

    // Hourly: last 24 hours, 1-hour slots (ages 1h..24h)
    for slot in 1..24 {
        let min_age = slot * HOUR;
        let max_age = (slot + 1) * HOUR;
        if let Some(ts) = newest_in_age_range(timestamps, now, min_age, max_age) {
            keep.insert(ts);
        }
    }

    // Daily: last 7 days, 1-day slots (ages 1d..7d)
    for slot in 1..=7 {
        let min_age = slot * DAY;
        let max_age = (slot + 1) * DAY;
        if let Some(ts) = newest_in_age_range(timestamps, now, min_age, max_age) {
            keep.insert(ts);
        }
    }

    // Weekly: last 5 weeks, 1-week slots (ages 1w..5w)
    for slot in 1..=5 {
        let min_age = slot * WEEK;
        let max_age = (slot + 1) * WEEK;
        if let Some(ts) = newest_in_age_range(timestamps, now, min_age, max_age) {
            keep.insert(ts);
        }
    }

    // Monthly: last 12 months, 30-day slots (ages 1mo..12mo)
    for slot in 1..=12 {
        let min_age = slot * MONTH;
        let max_age = (slot + 1) * MONTH;
        if let Some(ts) = newest_in_age_range(timestamps, now, min_age, max_age) {
            keep.insert(ts);
        }
    }

    // Yearly: older than 12 months, 365-day slots, indefinitely
    if let Some(&oldest) = timestamps.iter().min() {
        let max_age = now.saturating_sub(oldest);
        let mut min_age = 12 * MONTH;
        while min_age <= max_age {
            let slot_max = min_age.saturating_add(YEAR);
            if let Some(ts) = newest_in_age_range(timestamps, now, min_age, slot_max) {
                keep.insert(ts);
            }
            min_age = slot_max;
        }
    }

    keep
}

fn newest_in_age_range(timestamps: &[u64], now: u64, min_age: u64, max_age: u64) -> Option<u64> {
    timestamps
        .iter()
        .copied()
        .filter(|&ts| {
            let age = now.saturating_sub(ts);
            age >= min_age && age < max_age
        })
        .max()
}

pub fn fnv1a_hash(input: &str) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x00000100000001B3;
    let mut hash = FNV_OFFSET;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

pub fn notebook_dir_name(database_path: &str) -> String {
    let path = Path::new(database_path);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "notebook".to_string());
    let sanitised: String = stem
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let stem_part = if sanitised.len() > 40 {
        let mut end = 40;
        while end > 0 && !sanitised.is_char_boundary(end) {
            end -= 1;
        }
        sanitised[..end].to_string()
    } else {
        sanitised
    };
    let hash = fnv1a_hash(database_path);
    let mut name = stem_part;
    let _ = write!(name, "-{:016x}", hash);
    name
}

pub fn managed_notebook_dir(backup_folder: &str, database_path: &str) -> PathBuf {
    PathBuf::from(backup_folder)
        .join(MANAGED_ROOT)
        .join(notebook_dir_name(database_path))
}

pub fn backup_filename_for_timestamp(timestamp: u64) -> String {
    let mut name =
        String::with_capacity(BACKUP_FILENAME_PREFIX.len() + 20 + 1 + BACKUP_FILENAME_SUFFIX.len());
    name.push_str(BACKUP_FILENAME_PREFIX);
    name.push_str(&format_utc_timestamp(timestamp));
    name.push('Z');
    name.push_str(BACKUP_FILENAME_SUFFIX);
    name
}

pub fn parse_backup_timestamp(filename: &str) -> Option<u64> {
    managed_backup_timestamp(filename)
}

fn managed_backup_timestamp(filename: &str) -> Option<u64> {
    if !filename.starts_with(BACKUP_FILENAME_PREFIX) || !filename.ends_with(BACKUP_FILENAME_SUFFIX)
    {
        return None;
    }
    let inner = filename
        .strip_prefix(BACKUP_FILENAME_PREFIX)?
        .strip_suffix(BACKUP_FILENAME_SUFFIX)?;
    let inner = inner.strip_suffix('Z')?;
    parse_utc_timestamp(inner)
}

fn format_utc_timestamp(timestamp: u64) -> String {
    let secs = timestamp as i64;
    let days = secs.div_euclid(86_400);
    let time_of_day = secs.rem_euclid(86_400) as u32;

    let (year, month, day) = civil_from_days(days);
    let hour = time_of_day / 3600;
    let minute = (time_of_day % 3600) / 60;
    let second = time_of_day % 60;

    let mut value = String::with_capacity(19);
    let _ = write!(
        value,
        "{:04}-{:02}-{:02}T{:02}-{:02}-{:02}",
        year, month, day, hour, minute, second
    );
    value
}

fn parse_utc_timestamp(value: &str) -> Option<u64> {
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: u32 = date_parts.next()?.parse().ok()?;
    let day: u32 = date_parts.next()?.parse().ok()?;
    let mut time_parts = time.split('-');
    let hour: u32 = time_parts.next()?.parse().ok()?;
    let minute: u32 = time_parts.next()?.parse().ok()?;
    let second: u32 = time_parts.next()?.parse().ok()?;
    if date_parts.next().is_some() || time_parts.next().is_some() {
        return None;
    }
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let secs = days
        .checked_mul(86_400)?
        .checked_add(i64::from(hour * 3600 + minute * 60 + second))?;
    u64::try_from(secs).ok()
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m as u32, d as u32)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * i64::from(if month > 2 { month - 3 } else { month + 9 }) + 2) / 5
        + i64::from(day)
        - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn is_managed_backup_filename(filename: &str) -> bool {
    managed_backup_timestamp(filename).is_some()
}

pub fn list_managed_backup_timestamps(dir: &Path) -> Result<Vec<u64>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut timestamps = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_managed_backup_filename(&name) {
            continue;
        }
        if let Some(ts) = parse_backup_timestamp(&name) {
            timestamps.push(ts);
        }
    }
    timestamps.sort_unstable();
    Ok(timestamps)
}

pub fn newest_backup_timestamp(dir: &Path) -> Result<Option<u64>, String> {
    Ok(list_managed_backup_timestamps(dir)?.into_iter().max())
}

pub fn is_backup_due(dir: &Path, now: u64) -> Result<bool, String> {
    match newest_backup_timestamp(dir)? {
        None => Ok(true),
        Some(latest) => Ok(now.saturating_sub(latest) >= BACKUP_INTERVAL_SECS),
    }
}

pub fn prune_managed_backups(dir: &Path, now: u64) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    let timestamps = list_managed_backup_timestamps(dir)?;
    let keep = backups_to_keep(&timestamps, now);
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_managed_backup_filename(&name) {
            continue;
        }
        let Some(ts) = parse_backup_timestamp(&name) else {
            continue;
        };
        if !keep.contains(&ts) {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Temporary snapshot filename; must not match managed backup parser.
pub fn backup_snapshot_temp_filename() -> String {
    format!(
        ".treenote-backup-inprogress-{}.partial",
        uuid::Uuid::new_v4()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;
    use uuid::Uuid;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("treenote-backup-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write_backup(dir: &Path, timestamp: u64) -> PathBuf {
        let name = backup_filename_for_timestamp(timestamp);
        let path = dir.join(&name);
        let mut file = File::create(&path).expect("create backup file");
        writeln!(file, "test").expect("write backup file");
        path
    }

    #[test]
    fn keeps_all_backups_under_24_hours() {
        let now = 1_700_000_000u64;
        let timestamps: Vec<u64> = (0..12).map(|i| now - i * HOUR).collect();
        let keep = backups_to_keep(&timestamps, now);
        assert_eq!(keep.len(), 12);
        for ts in &timestamps {
            assert!(keep.contains(ts));
        }
    }

    #[test]
    fn ten_minute_retention_keeps_six_in_newest_hour() {
        let now = 1_700_000_000u64;
        let timestamps: Vec<u64> = (0..6).map(|i| now - i * TEN_MIN - 60).collect();
        let keep = backups_to_keep(&timestamps, now);
        assert_eq!(keep.len(), 6);
        for ts in &timestamps {
            assert!(keep.contains(ts));
        }
    }

    #[test]
    fn ten_minute_retention_thins_seventh_in_same_slot() {
        let now = 1_700_000_000u64;
        let ts_old = now - 300;
        let ts_newer = now - 120;
        let keep = backups_to_keep(&[ts_old, ts_newer], now);
        assert!(keep.contains(&ts_newer));
        assert!(!keep.contains(&ts_old));
    }

    #[test]
    fn ten_minute_to_hourly_transition_keeps_one_per_hour() {
        let now = 1_700_000_000u64;
        let in_first_hour_old = now - 70 * 60;
        let in_first_hour_new = now - 65 * 60;
        let in_second_hour = now - 150 * 60;
        let keep = backups_to_keep(&[in_first_hour_old, in_first_hour_new, in_second_hour], now);
        assert!(keep.contains(&in_first_hour_new));
        assert!(!keep.contains(&in_first_hour_old));
        assert!(keep.contains(&in_second_hour));
    }

    #[test]
    fn thins_to_hourly_after_24_hours() {
        let now = 1_700_000_000u64;
        // Two backups in the same hour slot (ages 25h and 25h30m)
        let ts_old = now - 25 * HOUR - 1800;
        let ts_newer = now - 25 * HOUR;
        let keep = backups_to_keep(&[ts_old, ts_newer], now);
        assert!(keep.contains(&ts_newer));
        assert!(!keep.contains(&ts_old));
    }

    #[test]
    fn daily_retention_keeps_one_per_day() {
        let now = 1_700_000_000u64;
        let day2_old = now - 2 * DAY - 3600;
        let day2_new = now - 2 * DAY;
        let day3 = now - 3 * DAY;
        let keep = backups_to_keep(&[day2_old, day2_new, day3], now);
        assert!(keep.contains(&day2_new));
        assert!(!keep.contains(&day2_old));
        assert!(keep.contains(&day3));
    }

    #[test]
    fn weekly_retention_keeps_one_per_week() {
        let now = 1_700_000_000u64;
        let w2_old = now - 2 * WEEK - DAY;
        let w2_new = now - 2 * WEEK;
        let keep = backups_to_keep(&[w2_old, w2_new], now);
        assert!(keep.contains(&w2_new));
        assert!(!keep.contains(&w2_old));
    }

    #[test]
    fn monthly_retention_keeps_one_per_month() {
        let now = 1_700_000_000u64;
        let m3_old = now - 3 * MONTH - DAY;
        let m3_new = now - 3 * MONTH;
        let keep = backups_to_keep(&[m3_old, m3_new], now);
        assert!(keep.contains(&m3_new));
        assert!(!keep.contains(&m3_old));
    }

    #[test]
    fn yearly_retention_keeps_one_per_year() {
        let now = 1_700_000_000u64;
        let y2_old = now - 14 * MONTH - DAY;
        let y2_new = now - 14 * MONTH;
        let keep = backups_to_keep(&[y2_old, y2_new], now);
        assert!(keep.contains(&y2_new));
        assert!(!keep.contains(&y2_old));
    }

    #[test]
    fn single_backup_can_satisfy_multiple_tiers() {
        let now = 1_700_000_000u64;
        let ts = now - 2 * HOUR;
        let keep = backups_to_keep(&[ts], now);
        assert_eq!(keep.len(), 1);
        assert!(keep.contains(&ts));
    }

    #[test]
    fn notebook_dirs_differ_for_same_filename_different_path() {
        let a = notebook_dir_name("C:/notes/work.sqlite3");
        let b = notebook_dir_name("D:/archive/work.sqlite3");
        assert_ne!(a, b);
        assert!(a.starts_with("work-"));
        assert!(b.starts_with("work-"));
    }

    #[test]
    fn notebook_dirs_same_for_same_path() {
        let path = "C:/notes/mybook.sqlite3";
        assert_eq!(notebook_dir_name(path), notebook_dir_name(path));
    }

    #[test]
    fn notebook_dir_name_truncates_long_ascii_stem_at_40_bytes() {
        let stem = "a".repeat(50);
        let path = format!("C:/notes/{stem}.sqlite3");
        let name = notebook_dir_name(&path);
        let expected_stem = "a".repeat(40);
        let hash = fnv1a_hash(&path);
        assert_eq!(name, format!("{expected_stem}-{hash:016x}"));
    }

    #[test]
    fn notebook_dir_name_truncates_long_unicode_stem_on_char_boundary() {
        let stem = "あ".repeat(20);
        let path = format!("C:/notes/{stem}.sqlite3");
        let name = notebook_dir_name(&path);
        let expected_stem = "あ".repeat(13);
        let hash = fnv1a_hash(&path);
        assert_eq!(name, format!("{expected_stem}-{hash:016x}"));
        assert_eq!(expected_stem.len(), 39);
    }

    #[test]
    fn parse_and_format_backup_filename_roundtrip() {
        let ts = 1_700_000_000u64;
        let name = backup_filename_for_timestamp(ts);
        assert_eq!(parse_backup_timestamp(&name), Some(ts));
        assert!(is_managed_backup_filename(&name));
    }

    #[test]
    fn malformed_files_are_not_recognised() {
        assert!(!is_managed_backup_filename(
            "treenote-backup-1700000000.sqlite3"
        ));
        assert!(!is_managed_backup_filename("random.txt"));
        assert!(!is_managed_backup_filename(
            "treenote-backup-not-a-date.sqlite3"
        ));
    }

    #[test]
    fn prune_leaves_unrecognised_files() {
        let dir = temp_dir();
        let now = 1_700_000_000u64;
        // 30 hourly backups spanning >24h
        for i in 0..30 {
            write_backup(&dir, now - i * HOUR);
        }
        let junk = dir.join("notes.txt");
        fs::write(&junk, "keep me").expect("write junk");
        let legacy = dir.join("treenote-backup-1700000000.sqlite3");
        fs::write(&legacy, "legacy").expect("write legacy");

        prune_managed_backups(&dir, now).expect("prune");

        assert!(junk.exists());
        assert!(legacy.exists());
        let remaining: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| is_managed_backup_filename(&e.file_name().to_string_lossy()))
            .map(|e| parse_backup_timestamp(&e.file_name().to_string_lossy()).unwrap())
            .collect();
        let keep = backups_to_keep(&(0..30).map(|i| now - i * HOUR).collect::<Vec<_>>(), now);
        assert_eq!(remaining.len(), keep.len());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_only_affects_target_notebook_dir() {
        let root = temp_dir();
        let dir_a = root.join("notebook-a");
        let dir_b = root.join("notebook-b");
        fs::create_dir_all(&dir_a).unwrap();
        fs::create_dir_all(&dir_b).unwrap();
        let now = 1_700_000_000u64;
        for i in 0..30 {
            write_backup(&dir_a, now - i * HOUR);
            write_backup(&dir_b, now - i * HOUR);
        }
        prune_managed_backups(&dir_a, now).expect("prune a");
        let count_a = fs::read_dir(&dir_a)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .map(|e| is_managed_backup_filename(&e.file_name().to_string_lossy()))
                    .unwrap_or(false)
            })
            .count();
        let count_b = fs::read_dir(&dir_b)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .map(|e| is_managed_backup_filename(&e.file_name().to_string_lossy()))
                    .unwrap_or(false)
            })
            .count();
        assert!(count_a < 30);
        assert_eq!(count_b, 30);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn is_backup_due_when_no_backups_or_stale() {
        let dir = temp_dir();
        let now = 1_700_000_000u64;
        assert!(is_backup_due(&dir, now).unwrap());
        write_backup(&dir, now - BACKUP_INTERVAL_SECS + 60);
        assert!(!is_backup_due(&dir, now).unwrap());
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        write_backup(&dir, now - BACKUP_INTERVAL_SECS - 1);
        assert!(is_backup_due(&dir, now).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn managed_notebook_dir_structure() {
        let dir = managed_notebook_dir("C:/backups", "C:/notes/mybook.sqlite3");
        let path_str = dir.to_string_lossy();
        assert!(path_str.contains("TreeNote Backups"));
        assert!(path_str.contains("mybook-"));
    }
}
