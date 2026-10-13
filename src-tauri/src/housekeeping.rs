//! Selection and transactional execution of inactive-branch archiving.
//! Access times are local usage metadata; explicit archive and unarchive
//! markers remain part of the logical notebook lifecycle.
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

pub const DEFAULT_ARCHIVE_DAYS: u64 = 90;
const DAY_MILLIS: i64 = 86_400_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveCandidate {
    pub id: String,
    pub label: String,
    pub note_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePreview {
    pub days: u64,
    pub candidates: Vec<ArchiveCandidate>,
    pub total_notes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveSweepResult {
    pub archived_branches: usize,
    pub archived_notes: usize,
    pub skipped_branches: usize,
    pub archived_ids: Vec<String>,
}

#[derive(Debug)]
struct Note {
    id: String,
    parent_id: Option<String>,
    label: String,
    created_at: Option<i64>,
    modified_at: Option<i64>,
    last_accessed_at: Option<i64>,
    archived_at: Option<i64>,
    last_unarchived_at: Option<i64>,
}

struct Evaluated {
    nodes: Vec<Note>,
    children: Vec<Vec<usize>>,
    roots: Vec<usize>,
    eligible: Vec<bool>,
    active_counts: Vec<usize>,
}

fn evaluate(conn: &Connection, days: u64, now: i64) -> Result<Evaluated, String> {
    if days == 0 || days > 36_500 {
        return Err("Archive threshold must be between 1 and 36500 days".into());
    }
    let days_ms = (days as i64)
        .checked_mul(DAY_MILLIS)
        .ok_or("Invalid archive threshold")?;
    let cutoff = now.saturating_sub(days_ms);
    let mut stmt = conn
        .prepare(
            "SELECT id, parent_id, label, created_at, modified_at, last_accessed_at, \
             archived_at, last_unarchived_at FROM notes ORDER BY rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Note {
                id: r.get(0)?,
                parent_id: r.get(1)?,
                label: r.get(2)?,
                created_at: r.get(3)?,
                modified_at: r.get(4)?,
                last_accessed_at: r.get(5)?,
                archived_at: r.get(6)?,
                last_unarchived_at: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let nodes = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let by_id: HashMap<&str, usize> = nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.id.as_str(), i))
        .collect();
    let mut children = vec![Vec::new(); nodes.len()];
    let mut roots = Vec::new();
    for (i, node) in nodes.iter().enumerate() {
        match node.parent_id.as_deref().and_then(|p| by_id.get(p).copied()) {
            Some(parent) => children[parent].push(i),
            None => roots.push(i),
        }
    }
    let mut eligible = vec![false; nodes.len()];
    let mut active_counts = vec![0; nodes.len()];
    let mut visiting = HashSet::new();

    fn check(
        i: usize,
        inherited_unarchive: bool,
        cutoff: i64,
        nodes: &[Note],
        children: &[Vec<usize>],
        eligible: &mut [bool],
        active_counts: &mut [usize],
        visiting: &mut HashSet<usize>,
    ) -> Result<bool, String> {
        if nodes[i].archived_at.is_some() {
            return Ok(true); // already hidden; not a candidate and not a veto
        }
        if !visiting.insert(i) {
            return Err("Invalid notebook hierarchy: cycle found".into());
        }
        let recent_unarchive = inherited_unarchive
            || nodes[i].last_unarchived_at.is_some_and(|date| date > cutoff);
        let recent_activity = [nodes[i].created_at, nodes[i].modified_at, nodes[i].last_accessed_at]
            .iter()
            .flatten()
            .any(|date| *date > cutoff);
        let mut is_eligible = !recent_unarchive && !recent_activity;
        let mut count = 1;
        for &child in &children[i] {
            let child_eligible = check(
                child,
                recent_unarchive,
                cutoff,
                nodes,
                children,
                eligible,
                active_counts,
                visiting,
            )?;
            is_eligible &= child_eligible;
            count += active_counts[child];
        }
        visiting.remove(&i);
        eligible[i] = is_eligible;
        active_counts[i] = count;
        Ok(is_eligible)
    }

    for &root in &roots {
        check(
            root,
            false,
            cutoff,
            &nodes,
            &children,
            &mut eligible,
            &mut active_counts,
            &mut visiting,
        )?;
    }

    Ok(Evaluated {
        nodes,
        children,
        roots,
        eligible,
        active_counts,
    })
}

fn candidates(e: &Evaluated) -> Vec<ArchiveCandidate> {
    fn collect(i: usize, e: &Evaluated, result: &mut Vec<ArchiveCandidate>) {
        if e.nodes[i].archived_at.is_some() {
            return;
        }
        if e.eligible[i] {
            result.push(ArchiveCandidate {
                id: e.nodes[i].id.clone(),
                label: e.nodes[i].label.clone(),
                note_count: e.active_counts[i],
            });
        } else {
            for &child in &e.children[i] {
                collect(child, e, result);
            }
        }
    }
    let mut result = Vec::new();
    for &root in &e.roots {
        collect(root, e, &mut result);
    }
    result
}

pub fn preview(conn: &Connection, days: u64, now: i64) -> Result<ArchivePreview, String> {
    let evaluated = evaluate(conn, days, now)?;
    let candidates = candidates(&evaluated);
    let total_notes = candidates.iter().map(|c| c.note_count).sum();
    Ok(ArchivePreview {
        days,
        candidates,
        total_notes,
    })
}

/// Re-evaluate candidates inside the write transaction. A manual run can only
/// archive IDs shown in its preview; freshly eligible branches cannot slip in.
pub fn execute(
    conn: &mut Connection,
    days: u64,
    now: i64,
    previewed_ids: Option<&[String]>,
) -> Result<ArchiveSweepResult, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let evaluated = evaluate(&tx, days, now)?;
    let currently_eligible = candidates(&evaluated);
    let allowed: HashSet<&str> = currently_eligible.iter().map(|c| c.id.as_str()).collect();
    let mut result = ArchiveSweepResult {
        archived_branches: 0,
        archived_notes: 0,
        skipped_branches: 0,
        archived_ids: Vec::new(),
    };
    let mut seen = HashSet::new();
    let selected: Vec<&ArchiveCandidate> = match previewed_ids {
        Some(ids) => {
            result.skipped_branches = ids
                .iter()
                .filter(|id| seen.insert(id.as_str()) && !allowed.contains(id.as_str()))
                .count();
            let chosen: HashSet<&str> = ids.iter().map(String::as_str).collect();
            currently_eligible
                .iter()
                .filter(|c| chosen.contains(c.id.as_str()))
                .collect()
        }
        None => currently_eligible.iter().collect(),
    };
    for candidate in selected {
        let changed = tx
            .execute(
                "UPDATE notes SET archived_at=?1, modified_at=?1 \
                 WHERE id=?2 AND archived_at IS NULL",
                params![now, candidate.id],
            )
            .map_err(|e| e.to_string())?;
        if changed == 1 {
            result.archived_branches += 1;
            result.archived_notes += candidate.note_count;
            result.archived_ids.push(candidate.id.clone());
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (
                id TEXT PRIMARY KEY,
                parent_id TEXT,
                label TEXT NOT NULL,
                created_at INTEGER,
                modified_at INTEGER,
                last_accessed_at INTEGER,
                archived_at INTEGER,
                last_unarchived_at INTEGER
            )",
        )
        .unwrap();
        conn
    }
    fn put(
        conn: &Connection,
        id: &str,
        parent: Option<&str>,
        created: Option<i64>,
        modified: Option<i64>,
        accessed: Option<i64>,
    ) {
        conn.execute(
            "INSERT INTO notes (id,parent_id,label,created_at,modified_at,last_accessed_at) \
             VALUES (?1,?2,?1,?3,?4,?5)",
            params![id, parent, created, modified, accessed],
        )
        .unwrap();
    }

    const NOW: i64 = 200 * DAY_MILLIS;

    #[test]
    fn archives_highest_eligible_branch_and_preserves_descendant_timestamps() {
        let mut conn = db();
        put(&conn, "root", None, None, None, None);
        put(&conn, "child", Some("root"), None, None, None);
        let p = preview(&conn, 90, NOW).unwrap();
        assert_eq!(p.candidates[0].id, "root");
        assert_eq!(p.total_notes, 2);
        let run = execute(&mut conn, 90, NOW, None).unwrap();
        assert_eq!((run.archived_branches, run.archived_notes), (1, 2));
        let state: (Option<i64>, Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT created_at, modified_at, archived_at FROM notes WHERE id='child'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(state, (None, None, None));
        let again = execute(&mut conn, 90, NOW + 1, None).unwrap();
        assert_eq!(again.archived_branches, 0);
    }

    #[test]
    fn active_descendant_prevents_parent_but_inactive_sibling_can_archive() {
        let conn = db();
        put(&conn, "root", None, None, None, None);
        put(&conn, "active", Some("root"), Some(NOW - DAY_MILLIS), None, None);
        put(&conn, "old", Some("root"), None, None, None);
        let p = preview(&conn, 90, NOW).unwrap();
        assert_eq!(p.candidates.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["old"]);
    }

    #[test]
    fn recent_access_protects_an_unchanged_note() {
        let conn = db();
        put(&conn, "root", None, None, None, None);
        put(&conn, "read", Some("root"), None, None, Some(NOW - DAY_MILLIS));
        let p = preview(&conn, 90, NOW).unwrap();
        assert!(p.candidates.is_empty());
    }

    #[test]
    fn recent_unarchive_protects_descendants() {
        let conn = db();
        put(&conn, "root", None, None, Some(NOW - 190 * DAY_MILLIS), None);
        put(&conn, "child", Some("root"), None, None, None);
        conn.execute(
            "UPDATE notes SET last_unarchived_at=?1 WHERE id='root'",
            [NOW - DAY_MILLIS],
        ).unwrap();
        assert!(preview(&conn, 90, NOW).unwrap().candidates.is_empty());
        assert_eq!(preview(&conn, 90, NOW + 91 * DAY_MILLIS).unwrap().candidates[0].id, "root");
    }

    #[test]
    fn existing_archived_descendant_is_skipped_not_overwritten() {
        let mut conn = db();
        put(&conn, "root", None, None, None, None);
        put(&conn, "hidden", Some("root"), None, None, None);
        conn.execute("UPDATE notes SET archived_at=123 WHERE id='hidden'", []).unwrap();
        let p = preview(&conn, 90, NOW).unwrap();
        assert_eq!(p.total_notes, 1);
        execute(&mut conn, 90, NOW, None).unwrap();
        let existing: i64 = conn.query_row(
            "SELECT archived_at FROM notes WHERE id='hidden'", [], |r| r.get(0)
        ).unwrap();
        assert_eq!(existing, 123);
    }

    #[test]
    fn manual_execution_never_adds_unpreviewed_branches() {
        let mut conn = db();
        put(&conn, "a", None, None, None, None);
        let p = preview(&conn, 90, NOW).unwrap();
        put(&conn, "b", None, None, None, None);
        let ids = p.candidates.into_iter().map(|c| c.id).collect::<Vec<_>>();
        let result = execute(&mut conn, 90, NOW, Some(&ids)).unwrap();
        assert_eq!(result.archived_branches, 1);
        let b: Option<i64> = conn.query_row(
            "SELECT archived_at FROM notes WHERE id='b'", [], |r| r.get(0)
        ).unwrap();
        assert_eq!(b, None);
    }

    #[test]
    fn manual_execution_skips_candidates_changed_after_preview() {
        let mut conn = db();
        put(&conn, "root", None, None, None, None);
        put(&conn, "child", Some("root"), None, None, None);
        let ids = preview(&conn, 90, NOW).unwrap().candidates.into_iter().map(|c| c.id).collect::<Vec<_>>();
        conn.execute("UPDATE notes SET modified_at=?1 WHERE id='child'", [NOW]).unwrap();
        let result = execute(&mut conn, 90, NOW, Some(&ids)).unwrap();
        assert_eq!((result.archived_branches, result.skipped_branches), (0, 1));
    }

    #[test]
    fn rejects_invalid_threshold() {
        let conn = db();
        assert!(preview(&conn, 0, NOW).is_err());
        assert!(preview(&conn, 100_000, NOW).is_err());
    }
}
