#!/usr/bin/env python3
"""
Developer-only fixture for manual empty-note cleanup testing (PR #35).
Builds a genuine TreeNote schema-v3 SQLite notebook and verifies candidates
using the same rules as src-tauri/src/cleanup.rs preview().
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

NOTEBOOK_FILENAME = "empty-cleanup-test.sqlite3"
LOCK_SUFFIX = ".treenote.lock"
MANAGED_BACKUPS_ROOT = "TreeNote Backups"
DEFAULT_ARCHIVE_DAYS = 90
DAY_MILLIS = 86_400_000
BATCH_SIZE = 20
WEEKDAYS = ("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")

CREATE_NOTES_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    label TEXT NOT NULL,
    is_expanded INTEGER,
    sort_order INTEGER NOT NULL,
    content TEXT,
    created_at INTEGER,
    modified_at INTEGER,
    archived_at INTEGER,
    last_accessed_at INTEGER,
    last_unarchived_at INTEGER,
    generated_title_untouched INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS notes_parent_id_idx ON notes(parent_id);
"""

EXPECTED_ELIGIBLE_IDS = (
    [f"eligible-a-{i:02d}" for i in range(1, 21)]
    + [f"eligible-b-{i:02d}" for i in range(1, 21)]
    + [f"eligible-c-{i:02d}" for i in range(1, 6)]
)

INELIGIBLE_IDS = (
    "ineligible-nonempty",
    "ineligible-whitespace",
    "ineligible-parent-with-child",
    "ineligible-recent-access",
    "ineligible-renamed",
    "ineligible-restored-title",
    "ineligible-cleared-content",
    "ineligible-imported-legacy",
    "ineligible-archived",
)


def fnv1a_hash(text: str) -> int:
    """Mirror backup.rs fnv1a_hash for managed backup directory names."""
    offset = 0xCBF29CE484222325
    prime = 0x00000100000001B3
    h = offset
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * prime) & 0xFFFFFFFFFFFFFFFF
    return h


def notebook_dir_name(database_path: str) -> str:
    path = Path(database_path)
    stem = path.stem or "notebook"
    sanitised = "".join(
        "_" if c in '<>:"/\\|?*' else c for c in stem
    )
    if len(sanitised) > 40:
        sanitised = sanitised[:40]
    digest = fnv1a_hash(database_path)
    return f"{sanitised}-{digest:016x}"


def format_default_node_title(when: datetime) -> str:
    """Match src/lib/tree.ts formatDefaultNodeTitle (English weekday)."""
    # Python weekday(): Mon=0 … Sun=6; JS getDay(): Sun=0 … Sat=6
    day = WEEKDAYS[(when.weekday() + 1) % 7]
    return (
        f"{day} {when.hour:02d}:{when.minute:02d}:{when.second:02d} "
        f"{when.year % 100:02d}/{when.month:02d}/{when.day:02d}"
    )


def is_timestamp_title(title: str) -> bool:
    """Mirror cleanup.rs is_timestamp_title."""
    if len(title) != 21 or not title.isascii():
        return False
    if title[:3] not in WEEKDAYS:
        return False
    if (
        title[3] != " "
        or title[6] != ":"
        or title[9] != ":"
        or title[12] != " "
        or title[15] != "/"
        or title[18] != "/"
    ):
        return False
    for i in (4, 5, 7, 8, 10, 11, 13, 14, 16, 17, 19, 20):
        if not title[i].isdigit():
            return False

    def pair(i: int) -> int:
        return int(title[i : i + 2])

    return (
        pair(4) <= 23
        and pair(7) <= 59
        and pair(10) <= 59
        and 1 <= pair(16) <= 12
        and 1 <= pair(19) <= 31
    )


@dataclass
class NoteRow:
    id: str
    parent_id: str | None
    label: str
    content: str
    created_at: int | None
    modified_at: int | None
    last_accessed_at: int | None = None
    last_unarchived_at: int | None = None
    archived_at: int | None = None
    generated_title_untouched: int = 0
    is_expanded: int = 1
    sort_order: int = 0


def cutoff_ms(days: int, now_ms: int) -> int:
    if not 1 <= days <= 36_500:
        raise ValueError("Inactivity threshold must be between 1 and 36500 days")
    return max(0, now_ms - days * DAY_MILLIS)


def eligible(note: NoteRow, cut: int) -> bool:
    if not note.generated_title_untouched or not is_timestamp_title(note.label):
        return False
    if note.content != "" or note.archived_at is not None:
        return False
    if note.created_at is None or note.modified_at is None:
        return False
    created, modified = note.created_at, note.modified_at
    if created > cut or modified < created or modified > cut:
        return False
    if note.last_accessed_at is not None and note.last_accessed_at > cut:
        return False
    if note.last_unarchived_at is not None and note.last_unarchived_at > cut:
        return False
    return True


def preview_candidate_ids(conn: sqlite3.Connection, days: int, now_ms: int) -> list[str]:
    """Mirror cleanup.rs preview() candidate selection (ORDER BY rowid)."""
    cut = cutoff_ms(days, now_ms)
    rows = conn.execute(
        """
        SELECT id, parent_id, label, COALESCE(content,''), created_at, modified_at,
               last_accessed_at, last_unarchived_at, archived_at, generated_title_untouched
        FROM notes ORDER BY rowid
        """
    ).fetchall()
    notes: list[NoteRow] = []
    for r in rows:
        notes.append(
            NoteRow(
                id=r[0],
                parent_id=r[1],
                label=r[2],
                content=r[3],
                created_at=r[4],
                modified_at=r[5],
                last_accessed_at=r[6],
                last_unarchived_at=r[7],
                archived_at=r[8],
                generated_title_untouched=r[9],
            )
        )
    by_id = {n.id: n for n in notes}
    parent_ids = {n.parent_id for n in notes if n.parent_id}
    candidates: list[str] = []
    for note in notes:
        if note.id in parent_ids or not eligible(note, cut):
            continue
        visited: set[str] = {note.id}
        parent_id = note.parent_id
        safe = True
        while parent_id:
            if parent_id in visited:
                safe = False
                break
            parent = by_id.get(parent_id)
            if parent is None:
                safe = False
                break
            if parent.archived_at is not None:
                safe = False
                break
            visited.add(parent_id)
            parent_id = parent.parent_id
        if safe:
            candidates.append(note.id)
    return candidates


def read_windows_data_root() -> Path | None:
    if sys.platform != "win32":
        return None
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\TreeNote") as key:
            value, _ = winreg.QueryValueEx(key, "DataRoot")
        if not value or not str(value).strip():
            return None
        path = Path(str(value).strip())
        if not path.is_absolute():
            return None
        return path
    except OSError:
        return None


def resolve_data_root() -> Path:
    configured = read_windows_data_root()
    if configured is not None:
        return configured
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "treenote"
    return Path.home() / "AppData" / "Roaming" / "treenote"


def read_settings(data_root: Path) -> dict[str, Any]:
    path = data_root / "settings.json"
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def lock_is_held(lock_path: Path) -> bool:
    if not lock_path.is_file():
        return False
    if sys.platform == "win32":
        import msvcrt

        try:
            with open(lock_path, "r+b") as handle:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            return False
        except OSError:
            return True
    import fcntl

    try:
        with open(lock_path, "r+b") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        return False
    except OSError:
        return True


def assert_auto_archive_off(settings: dict[str, Any], for_write: bool) -> None:
    if not for_write:
        return
    if settings.get("housekeeping_auto_archive"):
        print(
            "Refusing to write the test notebook: Settings → Housekeeping has "
            '"Automatically archive inactive branches" enabled.\n'
            "That setting is install-wide (not per notebook). While it is on, "
            "TreeNote will archive the fixture's inactive empty leaves and they "
            "will disappear from empty-note cleanup.\n"
            "Turn automatic archiving off, then run this script again.",
            file=sys.stderr,
        )
        sys.exit(1)
    days = settings.get("housekeeping_archive_after_days", DEFAULT_ARCHIVE_DAYS)
    if days != DEFAULT_ARCHIVE_DAYS:
        print(
            f"Warning: housekeeping inactivity threshold is {days} days, not "
            f"{DEFAULT_ARCHIVE_DAYS}. Fixture leaves are ~120 days old; a higher "
            "threshold may exclude them from cleanup.",
            file=sys.stderr,
        )


def build_fixture_rows(now_ms: int) -> list[NoteRow]:
    old_base = datetime.fromtimestamp((now_ms - 120 * DAY_MILLIS) / 1000.0)
    old_ms = int(old_base.timestamp() * 1000)

    def old_title(second_offset: int) -> str:
        t = old_base + timedelta(seconds=second_offset)
        return format_default_node_title(t)

    rows: list[NoteRow] = []

    folders = [
        ("folder-eligible-a", None, "01 Eligible A (20 empty leaves)", 0),
        ("folder-eligible-b", None, "02 Eligible B (20 empty leaves)", 1),
        ("folder-eligible-c", None, "03 Eligible C (5 empty leaves)", 2),
        ("folder-ineligible", None, "04 Ineligible — must not appear in cleanup", 3),
    ]
    for fid, parent, label, order in folders:
        rows.append(
            NoteRow(
                id=fid,
                parent_id=parent,
                label=label,
                content="",
                created_at=old_ms,
                modified_at=old_ms,
                generated_title_untouched=0,
                is_expanded=1,
                sort_order=order,
            )
        )

    sec = 0
    for i in range(1, 21):
        sec += 1
        rows.append(
            NoteRow(
                id=f"eligible-a-{i:02d}",
                parent_id="folder-eligible-a",
                label=old_title(sec),
                content="",
                created_at=old_ms,
                modified_at=old_ms,
                generated_title_untouched=1,
                sort_order=i - 1,
            )
        )
    for i in range(1, 21):
        sec += 1
        rows.append(
            NoteRow(
                id=f"eligible-b-{i:02d}",
                parent_id="folder-eligible-b",
                label=old_title(sec),
                content="",
                created_at=old_ms,
                modified_at=old_ms,
                generated_title_untouched=1,
                sort_order=i - 1,
            )
        )
    for i in range(1, 6):
        sec += 1
        rows.append(
            NoteRow(
                id=f"eligible-c-{i:02d}",
                parent_id="folder-eligible-c",
                label=old_title(sec),
                content="",
                created_at=old_ms,
                modified_at=old_ms,
                generated_title_untouched=1,
                sort_order=i - 1,
            )
        )

    restored_title = old_title(9000)

    cases: list[tuple[str, str, NoteRow | list[NoteRow]]] = [
        (
            "Non-empty content",
            "folder-ineligible-nonempty",
            NoteRow(
                id="ineligible-nonempty",
                parent_id="folder-ineligible-nonempty",
                label=old_title(9100),
                content="hello",
                created_at=old_ms,
                modified_at=old_ms,
                generated_title_untouched=1,
            ),
        ),
        (
            "Whitespace only",
            "folder-ineligible-whitespace",
            NoteRow(
                id="ineligible-whitespace",
                parent_id="folder-ineligible-whitespace",
                label=old_title(9101),
                content=" ",
                created_at=old_ms,
                modified_at=old_ms,
                generated_title_untouched=1,
            ),
        ),
        (
            "Has children",
            "folder-ineligible-has-child",
            [
                NoteRow(
                    id="ineligible-parent-with-child",
                    parent_id="folder-ineligible-has-child",
                    label=old_title(9102),
                    content="",
                    created_at=old_ms,
                    modified_at=old_ms,
                    generated_title_untouched=1,
                ),
                NoteRow(
                    id="ineligible-has-child-decoy",
                    parent_id="ineligible-parent-with-child",
                    label="Child blocks parent cleanup",
                    content="",
                    created_at=old_ms,
                    modified_at=old_ms,
                    generated_title_untouched=0,
                ),
            ],
        ),
        (
            "Recently accessed",
            "folder-ineligible-recent-access",
            NoteRow(
                id="ineligible-recent-access",
                parent_id="folder-ineligible-recent-access",
                label=old_title(9103),
                content="",
                created_at=old_ms,
                modified_at=old_ms,
                last_accessed_at=now_ms,
                generated_title_untouched=1,
            ),
        ),
        (
            "Renamed",
            "folder-ineligible-renamed",
            NoteRow(
                id="ineligible-renamed",
                parent_id="folder-ineligible-renamed",
                label="Renamed away from timestamp title",
                content="",
                created_at=old_ms,
                modified_at=old_ms,
                generated_title_untouched=0,
            ),
        ),
        (
            "Renamed then restored title",
            "folder-ineligible-restored",
            NoteRow(
                id="ineligible-restored-title",
                parent_id="folder-ineligible-restored",
                label=restored_title,
                content="",
                created_at=old_ms,
                modified_at=old_ms,
                generated_title_untouched=0,
            ),
        ),
        (
            "Edited then cleared",
            "folder-ineligible-cleared",
            NoteRow(
                id="ineligible-cleared-content",
                parent_id="folder-ineligible-cleared",
                label=old_title(9104),
                content="",
                created_at=old_ms,
                modified_at=old_ms,
                generated_title_untouched=0,
            ),
        ),
        (
            "Imported / legacy provenance",
            "folder-ineligible-legacy",
            NoteRow(
                id="ineligible-imported-legacy",
                parent_id="folder-ineligible-legacy",
                label=old_title(9105),
                content="",
                created_at=old_ms,
                modified_at=old_ms,
                generated_title_untouched=0,
            ),
        ),
        (
            "Archived",
            "folder-ineligible-archived",
            NoteRow(
                id="ineligible-archived",
                parent_id="folder-ineligible-archived",
                label=old_title(9106),
                content="",
                created_at=old_ms,
                modified_at=old_ms,
                archived_at=old_ms,
                generated_title_untouched=0,
            ),
        ),
    ]

    for idx, (case_label, folder_id, payload) in enumerate(cases):
        rows.append(
            NoteRow(
                id=folder_id,
                parent_id="folder-ineligible",
                label=case_label,
                content="",
                created_at=old_ms,
                modified_at=old_ms,
                generated_title_untouched=0,
                sort_order=idx,
            )
        )
        if isinstance(payload, list):
            rows.extend(payload)
        else:
            rows.append(payload)

    # Legacy variant with NULL dates (still under legacy folder)
    rows.append(
        NoteRow(
            id="folder-ineligible-legacy-null",
            parent_id="folder-ineligible",
            label="Legacy NULL dates",
            content="",
            created_at=old_ms,
            modified_at=old_ms,
            generated_title_untouched=0,
            sort_order=len(cases),
        )
    )
    rows.append(
        NoteRow(
            id="ineligible-legacy-null-dates",
            parent_id="folder-ineligible-legacy-null",
            label=old_title(9200),
            content="",
            created_at=None,
            modified_at=None,
            generated_title_untouched=0,
        )
    )

    return rows


def write_notebook(path: Path, now_ms: int) -> None:
    if path.exists():
        path.unlink()
    conn = sqlite3.connect(path)
    try:
        conn.executescript(CREATE_NOTES_TABLE_SQL)
        conn.execute("PRAGMA user_version = 3")
        for row in build_fixture_rows(now_ms):
            conn.execute(
                """
                INSERT INTO notes (
                    id, parent_id, label, is_expanded, sort_order, content,
                    created_at, modified_at, archived_at, last_accessed_at,
                    last_unarchived_at, generated_title_untouched
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row.id,
                    row.parent_id,
                    row.label,
                    row.is_expanded,
                    row.sort_order,
                    row.content,
                    row.created_at,
                    row.modified_at,
                    row.archived_at,
                    row.last_accessed_at,
                    row.last_unarchived_at,
                    row.generated_title_untouched,
                ),
            )
        conn.commit()
    finally:
        conn.close()


def verify_notebook(path: Path, now_ms: int) -> None:
    conn = sqlite3.connect(path)
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version != 3:
            raise SystemExit(f"Expected schema user_version 3, got {version}")

        for note_id in EXPECTED_ELIGIBLE_IDS:
            title = conn.execute(
                "SELECT label FROM notes WHERE id=?", (note_id,)
            ).fetchone()
            if title is None:
                raise SystemExit(f"Missing fixture note {note_id}")
            if not is_timestamp_title(title[0]):
                raise SystemExit(f"Invalid timestamp title for {note_id}: {title[0]!r}")

        candidates = preview_candidate_ids(conn, DEFAULT_ARCHIVE_DAYS, now_ms)
        if candidates != list(EXPECTED_ELIGIBLE_IDS):
            missing = set(EXPECTED_ELIGIBLE_IDS) - set(candidates)
            extra = set(candidates) - set(EXPECTED_ELIGIBLE_IDS)
            msg = [f"Expected {len(EXPECTED_ELIGIBLE_IDS)} candidates, got {len(candidates)}"]
            if missing:
                msg.append(f"  missing: {sorted(missing)}")
            if extra:
                msg.append(f"  unexpected: {sorted(extra)}")
            raise SystemExit("\n".join(msg))

        for bad_id in INELIGIBLE_IDS:
            if bad_id in candidates:
                raise SystemExit(f"Ineligible note appeared in cleanup preview: {bad_id}")

        batches = [
            candidates[0:BATCH_SIZE],
            candidates[BATCH_SIZE : 2 * BATCH_SIZE],
            candidates[2 * BATCH_SIZE :],
        ]
        if [len(b) for b in batches] != [20, 20, 5]:
            raise SystemExit(f"Expected review groups 20/20/5, got {[len(b) for b in batches]}")
    finally:
        conn.close()

    print(f"Verified {len(EXPECTED_ELIGIBLE_IDS)} cleanup candidates in groups 20 / 20 / 5.")
    print(f"Notebook: {path}")


def managed_backup_dir(data_root: Path, notebook_path: Path) -> Path:
    db_setting = str(notebook_path).replace("/", "\\")
    name = notebook_dir_name(db_setting)
    return data_root / "backups" / MANAGED_BACKUPS_ROOT / name


def refuse_if_locked(notebook_path: Path) -> None:
    lock_path = Path(str(notebook_path) + LOCK_SUFFIX)
    if lock_is_held(lock_path):
        print(
            f"Refusing to modify {notebook_path.name}: TreeNote has this notebook open "
            f"({lock_path.name} is locked).\n"
            "Switch to another notebook or quit TreeNote, then retry.",
            file=sys.stderr,
        )
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Overwrite an existing installed test notebook",
    )
    parser.add_argument(
        "--purge-backups",
        action="store_true",
        help="Remove this notebook's managed backup subdirectory (requires --reset or existing notebook)",
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Verify an installed notebook without writing",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Install target notebooks directory (default: resolved TreeNote data root)",
    )
    args = parser.parse_args()

    data_root = resolve_data_root()
    notebooks_dir = args.output_dir if args.output_dir else data_root / "notebooks"
    notebook_path = notebooks_dir / NOTEBOOK_FILENAME
    settings = read_settings(data_root)

    print(f"TreeNote data root: {data_root}")
    print(f"Target notebook: {notebook_path}")

    now_ms = int(time.time() * 1000)

    if args.verify_only:
        if not notebook_path.is_file():
            print(f"No notebook at {notebook_path}", file=sys.stderr)
            sys.exit(1)
        verify_notebook(notebook_path, now_ms)
        return

    if args.purge_backups and not args.reset:
        print("--purge-backups requires --reset.", file=sys.stderr)
        sys.exit(1)

    write_action = not args.verify_only
    assert_auto_archive_off(settings, for_write=write_action)

    if notebook_path.is_file() and not args.reset:
        print(
            f"{NOTEBOOK_FILENAME} already exists at:\n  {notebook_path}\n"
            "Pass --reset to overwrite it, or --verify-only to check the current file.",
            file=sys.stderr,
        )
        sys.exit(1)

    if write_action:
        refuse_if_locked(notebook_path)
        notebooks_dir.mkdir(parents=True, exist_ok=True)

        temp = notebook_path.with_suffix(".sqlite3.tmp")
        try:
            write_notebook(temp, now_ms)
            verify_notebook(temp, now_ms)
            temp.replace(notebook_path)
        finally:
            if temp.exists() and temp != notebook_path:
                temp.unlink(missing_ok=True)

        if args.purge_backups:
            refuse_if_locked(notebook_path)
            backup_dir = managed_backup_dir(data_root, notebook_path)
            if backup_dir.is_dir():
                shutil.rmtree(backup_dir)
                print(f"Removed managed backups: {backup_dir}")

        print("Installed test notebook. Open TreeNote and switch to empty-cleanup-test.sqlite3.")


if __name__ == "__main__":
    main()
