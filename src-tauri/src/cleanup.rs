//! Manual-only deletion of provably generated, untouched, empty leaf notes.
//! Imported and pre-v3 notes have no provenance marker and are never inferred.
//! Candidates are revalidated in a write transaction before single-row DELETEs.
use rusqlite::{params, Connection, TransactionBehavior};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

const DAY_MILLIS: i64 = 86_400_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmptyNoteCandidate {
    pub id: String,
    pub label: String,
    pub parent_path: String,
    pub created_at: i64,
    pub modified_at: i64,
    pub last_accessed_at: Option<i64>,
    pub last_unarchived_at: Option<i64>,
    pub note_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmptyCleanupPreview {
    pub days: u64,
    pub notebook_path: String,
    pub total_notes: usize,
    pub candidates: Vec<EmptyNoteCandidate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmptyCleanupResult {
    pub deleted_ids: Vec<String>,
    pub skipped_ids: Vec<String>,
    pub backup_path: String,
}

#[derive(Debug)]
struct Note {
    id: String,
    parent_id: Option<String>,
    label: String,
    content: String,
    created_at: Option<i64>,
    modified_at: Option<i64>,
    last_accessed_at: Option<i64>,
    last_unarchived_at: Option<i64>,
    archived_at: Option<i64>,
    generated_title_untouched: bool,
}

/// Syntax of formatDefaultNodeTitle in src/lib/tree.ts; provenance comes
/// *only* from explicit UI creation, never from matching this pattern alone.
pub fn is_timestamp_title(title: &str) -> bool {
    let b = title.as_bytes();
    if b.len() != 21 || !b.iter().all(u8::is_ascii) {
        return false;
    }
    if !matches!(&title[0..3], "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat") {
        return false;
    }
    if b[3] != b' ' || b[6] != b':' || b[9] != b':'
        || b[12] != b' ' || b[15] != b'/' || b[18] != b'/'
        || ![4, 5, 7, 8, 10, 11, 13, 14, 16, 17, 19, 20]
            .iter().all(|&i| b[i].is_ascii_digit())
    {
        return false;
    }
    let number = |i: usize| (b[i] - b'0') as u32 * 10 + (b[i+1] - b'0') as u32;
    number(4) <= 23 && number(7) <= 59 && number(10) <= 59
        && (1..=12).contains(&number(16)) && (1..=31).contains(&number(19))
}

fn cutoff(days: u64, now: i64) -> Result<i64, String> {
    if !(1..=36_500).contains(&days) {
        return Err("Inactivity threshold must be between 1 and 36500 days".into());
    }
    Ok(now.saturating_sub((days as i64).saturating_mul(DAY_MILLIS)))
}

fn eligible(note: &Note, cutoff: i64) -> bool {
    // A title, or coincidentally equal created/modified dates, never suffices.
    if !note.generated_title_untouched || !is_timestamp_title(&note.label)
        || !note.content.is_empty() || note.archived_at.is_some()
    {
        return false;
    }
    let (Some(created), Some(modified)) = (note.created_at, note.modified_at) else {
        return false; // Unknown legacy lifecycle is unsafe for deletion.
    };
    created <= cutoff && modified >= created && modified <= cutoff
        && note.last_accessed_at.is_none_or(|when| when <= cutoff)
        && note.last_unarchived_at.is_none_or(|when| when <= cutoff)
}

pub fn preview(conn: &Connection, days: u64, now: i64) -> Result<EmptyCleanupPreview, String> {
    let cutoff = cutoff(days, now)?;
    let mut stmt = conn.prepare(
        "SELECT id, parent_id, label, COALESCE(content,''), created_at, modified_at, \
                last_accessed_at, last_unarchived_at, archived_at, generated_title_untouched \
         FROM notes ORDER BY rowid",
    ).map_err(|e| e.to_string())?;
    let notes = stmt.query_map([], |r| Ok(Note {
        id: r.get(0)?,
        parent_id: r.get(1)?,
        label: r.get(2)?,
        content: r.get(3)?,
        created_at: r.get(4)?,
        modified_at: r.get(5)?,
        last_accessed_at: r.get(6)?,
        last_unarchived_at: r.get(7)?,
        archived_at: r.get(8)?,
        generated_title_untouched: r.get::<_, i64>(9)? == 1,
    })).map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let by_id: HashMap<&str, &Note> = notes.iter().map(|n| (n.id.as_str(), n)).collect();
    let parent_ids: HashSet<&str> = notes.iter()
        .filter_map(|n| n.parent_id.as_deref()).collect();
    let mut candidates = Vec::new();
    for note in &notes {
        if parent_ids.contains(note.id.as_str()) || !eligible(note, cutoff) {
            continue;
        }
        let mut path = Vec::new();
        let mut visited = HashSet::new();
        visited.insert(note.id.as_str());
        let mut parent_id = note.parent_id.as_deref();
        let mut safe = true;
        while let Some(id) = parent_id {
            if !visited.insert(id) {
                safe = false;
                break;
            }
            let Some(parent) = by_id.get(id) else {
                safe = false; // Orphaned hierarchy: never delete.
                break;
            };
            if parent.archived_at.is_some() {
                safe = false; // Includes independently archived descendants.
                break;
            }
            path.push(parent.label.as_str());
            parent_id = parent.parent_id.as_deref();
        }
        if !safe { continue; }
        path.reverse();
        candidates.push(EmptyNoteCandidate {
            id: note.id.clone(),
            label: note.label.clone(),
            parent_path: if path.is_empty() { "Notebook root".into() } else { path.join(" / ") },
            created_at: note.created_at.expect("eligible has created_at"),
            modified_at: note.modified_at.expect("eligible has modified_at"),
            last_accessed_at: note.last_accessed_at,
            last_unarchived_at: note.last_unarchived_at,
            note_count: 1,
        });
    }
    Ok(EmptyCleanupPreview {
        days,
        notebook_path: String::new(),
        total_notes: candidates.len(),
        candidates,
    })
}

/// No recursive branch deletion. In a single immediate write transaction,
/// re-check every property and leave all newly changed candidates untouched.
pub fn execute(
    conn: &mut Connection,
    days: u64,
    now: i64,
    requested_ids: &[String],
) -> Result<EmptyCleanupResult, String> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let candidates = preview(&tx, days, now)?;
    let valid: HashMap<&str, &EmptyNoteCandidate> = candidates.candidates.iter()
        .map(|n| (n.id.as_str(), n)).collect();
    let mut result = EmptyCleanupResult {
        deleted_ids: Vec::new(),
        skipped_ids: Vec::new(),
        backup_path: String::new(),
    };
    let mut seen = HashSet::new();
    let mut affected_parents: HashSet<Option<String>> = HashSet::new();
    for id in requested_ids {
        if !seen.insert(id.as_str()) { continue; }
        let Some(candidate) = valid.get(id.as_str()) else {
            result.skipped_ids.push(id.clone());
            continue;
        };
        let parent: Option<String> = tx.query_row(
            "SELECT parent_id FROM notes WHERE id=?1",
            [id], |r| r.get(0),
        ).map_err(|e| e.to_string())?;
        let changed = tx.execute(
            "DELETE FROM notes WHERE id=?1 AND label=?2 \
             AND generated_title_untouched=1 AND COALESCE(content,'')='' \
             AND NOT EXISTS(SELECT 1 FROM notes WHERE parent_id=?1)",
            params![id, candidate.label],
        ).map_err(|e| e.to_string())?;
        if changed == 1 {
            result.deleted_ids.push(id.clone());
            affected_parents.insert(parent);
        } else {
            result.skipped_ids.push(id.clone());
        }
    }
    for parent in affected_parents {
        let mut stmt = tx.prepare(
            "SELECT id FROM notes WHERE parent_id IS ?1 ORDER BY sort_order, rowid"
        ).map_err(|e| e.to_string())?;
        let remaining = stmt.query_map(params![parent.as_deref()], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        drop(stmt);
        for (position, id) in remaining.iter().enumerate() {
            tx.execute("UPDATE notes SET sort_order=?1 WHERE id=?2",
                params![position as i64, id]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 200 * DAY_MILLIS;
    const TITLE: &str = "Sun 11:22:33 26/01/02";

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (
                id TEXT PRIMARY KEY, parent_id TEXT, label TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0, content TEXT,
                created_at INTEGER, modified_at INTEGER,
                last_accessed_at INTEGER, last_unarchived_at INTEGER,
                archived_at INTEGER, generated_title_untouched INTEGER NOT NULL DEFAULT 0
            )"
        ).unwrap();
        conn
    }

    fn put(conn: &Connection, id: &str, parent: Option<&str>, title: &str, flagged: bool) {
        conn.execute(
            "INSERT INTO notes (id,parent_id,label,created_at,modified_at,generated_title_untouched) \
             VALUES (?1,?2,?3,?4,?4,?5)",
            params![id, parent, title, 10 * DAY_MILLIS, if flagged {1} else {0}],
        ).unwrap();
    }

    #[test]
    fn title_pattern_matches_actual_frontend_shape() {
        assert!(is_timestamp_title(TITLE));
        assert!(!is_timestamp_title("Sun 11:22:33 26/13/02"));
        assert!(!is_timestamp_title("Sun 11:22 26/01/02"));
        assert!(!is_timestamp_title("Another note"));
    }

    #[test]
    fn excludes_legacy_imported_modified_nonempty_and_nonleaf_notes() {
        let conn = db();
        put(&conn, "yes", None, TITLE, true);
        put(&conn, "legacy", None, TITLE, false);
        put(&conn, "renamed", None, "Other", true);
        put(&conn, "nonempty", None, TITLE, true);
        put(&conn, "parent", None, TITLE, true);
        put(&conn, "child", Some("parent"), TITLE, true);
        conn.execute("UPDATE notes SET content=' ' WHERE id='nonempty'", []).unwrap();
        conn.execute("UPDATE notes SET created_at=NULL WHERE id='child'", []).unwrap();
        let p = preview(&conn, 90, NOW).unwrap();
        assert_eq!(p.candidates.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), vec!["yes"]);
    }

    #[test]
    fn recent_activity_and_archived_ancestors_protect_notes() {
        let conn = db();
        put(&conn, "read", None, TITLE, true);
        put(&conn, "edit", None, TITLE, true);
        put(&conn, "new", None, TITLE, true);
        put(&conn, "hidden", None, "Folder", false);
        put(&conn, "descendant", Some("hidden"), TITLE, true);
        conn.execute("UPDATE notes SET last_accessed_at=?1 WHERE id='read'", [NOW]).unwrap();
        conn.execute("UPDATE notes SET modified_at=?1 WHERE id='edit'", [NOW]).unwrap();
        conn.execute("UPDATE notes SET created_at=?1 WHERE id='new'", [NOW]).unwrap();
        conn.execute("UPDATE notes SET archived_at=100 WHERE id='hidden'", []).unwrap();
        assert!(preview(&conn, 90, NOW).unwrap().candidates.is_empty());
    }

    #[test]
    fn revalidates_and_preserves_children_and_dense_order() {
        let mut conn = db();
        put(&conn, "parent", None, "Folder", false);
        put(&conn, "a", Some("parent"), TITLE, true);
        put(&conn, "b", Some("parent"), TITLE, true);
        put(&conn, "c", Some("parent"), TITLE, true);
        conn.execute("UPDATE notes SET sort_order=0 WHERE id='a'", []).unwrap();
        conn.execute("UPDATE notes SET sort_order=1 WHERE id='b'", []).unwrap();
        conn.execute("UPDATE notes SET sort_order=2 WHERE id='c'", []).unwrap();
        let seen = preview(&conn, 90, NOW).unwrap();
        assert_eq!(seen.candidates.len(), 3);
        conn.execute("UPDATE notes SET content='new' WHERE id='b'", []).unwrap();
        let result = execute(&mut conn, 90, NOW, &["a".into(), "b".into(), "a".into()]).unwrap();
        assert_eq!(result.deleted_ids, vec!["a"]);
        assert_eq!(result.skipped_ids, vec!["b"]);
        let siblings: Vec<(String, i64)> = conn.prepare(
            "SELECT id,sort_order FROM notes WHERE parent_id='parent' ORDER BY sort_order"
        ).unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
            .map(Result::unwrap).collect();
        assert_eq!(siblings, vec![("b".into(),0),("c".into(),1)]);
    }

    #[test]
    fn sqlite_abort_rolls_back_the_whole_group() {
        let mut conn = db();
        put(&conn, "a", None, TITLE, true);
        put(&conn, "b", None, TITLE, true);
        conn.execute_batch(
            "CREATE TRIGGER prevent_b BEFORE DELETE ON notes WHEN OLD.id='b'
             BEGIN SELECT RAISE(ABORT, 'disk or constraint failure'); END;"
        ).unwrap();
        assert!(execute(&mut conn, 90, NOW, &["a".into(), "b".into()]).is_err());
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn newly_added_child_during_review_skips_parent() {
        let mut conn = db();
        put(&conn, "a", None, TITLE, true);
        assert_eq!(preview(&conn, 90, NOW).unwrap().candidates.len(), 1);
        put(&conn, "child", Some("a"), "Other", false);
        let r = execute(&mut conn, 90, NOW, &["a".into()]).unwrap();
        assert!(r.deleted_ids.is_empty());
        assert_eq!(r.skipped_ids, vec!["a"]);
    }
}
