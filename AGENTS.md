# Agent instructions

This file is the operational context for coding agents working in TreeNote. Read it before changing code. For human-oriented build details, also read [DEVELOPERS.md](DEVELOPERS.md). GitHub Issues define the requested work; this file defines the stable product and architecture constraints around that work.

## Product scope

TreeNote is a deliberately small, local-first, plain-text note application. Notes are arranged in a hierarchy and stored in SQLite. The product should continue to feel like a simple tree editor, not a document suite or an agent platform.

Unless an issue explicitly says otherwise:

- keep notes plain text;
- preserve local-first operation and user ownership of files;
- do not introduce accounts, mandatory cloud services, rich text, Markdown rendering, or a second storage model;
- keep the UI simple and avoid adding settings or concepts that are not required by the issue;
- prefer narrow changes that fit the existing React/Tauri/SQLite design.

TreeNote currently supports one active notebook per running app instance.

## Architecture map

- `src/App.tsx` — top-level React state and coordination.
- `src/components/Tree.tsx` — tree rendering, selection, filtering, expansion, drag/drop, archive visibility.
- `src/components/TextPanel.tsx` — note editor and search UI.
- `src/lib/tree.ts` — frontend wrappers for Tauri tree commands.
- `src/lib/treeDepth.ts` — shared frontend depth limit.
- `src-tauri/src/main.rs` — Tauri commands and app startup.
- `src-tauri/src/storage.rs` — SQLite schema, migrations, note operations, notebook switching, settings, import/export integration, restore logic.
- `src-tauri/src/tree.rs` — serialized tree shape. Frontend-facing fields are camelCase.
- `src-tauri/src/data_root.rs` — data-root resolution and folder layout.
- `src-tauri/src/managed_notebook.rs` — notebook-name/path validation and managed-notebook boundary.
- `src-tauri/src/backup.rs`, `backup_meta.rs` — managed backups, retention and lock metadata.
- `src-tauri/src/notebook_lock.rs` — active-notebook locking.
- `src-tauri/src/convert/` — import/export formats.
- `installer/` and `scripts/build_installer.ps1` — Windows packaging.

## Data-root and notebook rules

The data root contains:

- `notebooks/`
- `backups/`
- `exports/`
- `settings.json`

The default notebook is `notebooks/treenote.sqlite3`.

On Windows the installer can configure an absolute data root under `HKCU\Software\TreeNote\DataRoot`; otherwise TreeNote uses its platform data directory. Do not casually move these responsibilities into per-notebook folders or allow ordinary notebook switching to escape the managed `notebooks/` directory.

Notebook switching/creation is intentionally constrained to managed `.sqlite3` files directly inside the configured `notebooks/` folder. Preserve path canonicalisation and symlink/path-escape checks.

## Current note schema and invariants

Current SQLite schema version: `PRAGMA user_version = 2`.

The `notes` table contains:

- `id`
- `parent_id`
- `label`
- `is_expanded`
- `sort_order`
- `content`
- `created_at`
- `modified_at`
- `archived_at`
- `last_accessed_at`
- `last_unarchived_at`

Database changes must use an explicit, tested migration. Opening an older valid TreeNote notebook must remain supported. Do not fabricate historical lifecycle timestamps during migration.

### Lifecycle semantics

- New notes get `created_at == modified_at == now`.
- Label/content changes update `modified_at` only when the value actually changes.
- Moving/reordering a note updates `modified_at` for the logically moved note only; do not stamp its parents, children or unaffected siblings.
- A no-op move must not update `modified_at`.
- Archive/unarchive is a logical note change and updates that note's `modified_at`.
- Expanding/collapsing is view state and must **not** update `modified_at`.
- Opening a selected note records `last_accessed_at` (coalesced to at most one write per hour) without changing `modified_at`. Tree expansion, searches, backups and background operations are not accesses. This field is **local usage metadata** and must be excluded from future logical sync hashes/snapshots.
- Duplicated notes/branches get fresh creation/modification timestamps and no archive markers.

These rules matter for future sync/conflict work. Do not broaden timestamp stamping for convenience.

### Archive semantics

`archived_at` is an **explicit marker on one note**, not a recursively-written subtree flag.

A note is effectively archived in the UI when it or any ancestor has an archive marker. Therefore:

- archiving a branch does not write `archived_at` onto every descendant;
- a descendant may have its own independent archive marker;
- unarchiving a parent reveals descendants except independently archived subtrees;
- explicitly unarchiving a note sets its `last_unarchived_at` so automated housekeeping cannot immediately rearchive its descendants; this marker is logical state and is preserved in TreeNote JSON and backups;
- the global **Show archived** view setting controls both tree visibility and search/filter scope.

Keep explicit archive state in storage and derived/effective archive state in the frontend unless an issue deliberately redesigns this model.

### Automatic housekeeping (issue #25)

- Automatic archiving is opt-in and defaults off; it checks approximately daily while TreeNote is running and unlocked. Manual preview and confirmation are always available.
- Default inactivity threshold is 90 days (selectable in Settings). A note is inactive when `created_at`, `modified_at` and `last_accessed_at` are all absent or older than the threshold. Do not manufacture historical timestamps: legacy NULLs count as unknown/old.
- Only archive entire inactive branches. Recently active descendants veto their ancestor's eligibility, but an inactive child branch under an active parent can qualify separately.
- Record an explicit archive marker on the highest eligible root only. Descendant timestamp and archive markers must not be rewritten; already effectively archived descendants are skipped.
- A recent explicit `last_unarchived_at` protects that note and its descendants for the configured inactivity period, including independently eligible child branches.
- Preview and execution use the same backend selector. The manual review launches from Settings → Housekeeping into a **separate, resizable Tauri window** with a two-pane layout: branch-selection list on the left and full read-only content preview on the right. The review captures a **fixed snapshot of candidate root IDs** divided into groups of 20. Each group retains its original members and positions throughout that review. Do **not** re-fetch and re-batch eligible roots after partially archiving a group; that would mix newly eligible candidates with deliberately unchecked branches. A deliberate **New scan** starts a new review and replaces the snapshot (with confirmation if choices or progress would be lost).
- All candidates start checked by default. Users can uncheck individual branches or select all/none within the current group. **Archive checked & continue** submits only checked IDs in that visible group, updates archived and backend-rejected rows within that fixed group, marks it reviewed, and advances to the next unreviewed group. **Keep entire group** marks the group reviewed without archiving. Previously unchecked branches stay kept, not redistributed; reviewed groups can be reopened to revise kept choices. Execution revalidates IDs in a transaction and must never imply that a failed UI notification undid a successful archive.
- Focusing a candidate in the manual preview shows a read-only text dump of that root and every descendant, sorted by sibling `sort_order`, with additional hyphens for each nesting level and each note's text beneath its title. Inspection must not change `last_accessed_at` or affect the archived/not-archived selection. A stale notebook or changed candidate must fail safely, and the UI must ignore late responses from previously focused branches.
- The existing tree context menu also supports explicit Archive/Archive branch/Unarchive for individual notes and branches, independently of the inactivity threshold.
- Scheduling preferences and last-run bookkeeping reside in install-local settings, keyed per notebook. They are not part of logical notebook state and should not trigger future sync.
- TreeNote JSON preserves `last_unarchived_at` (logical lifecycle state) but does not export `last_accessed_at` (local activity state). Physical SQLite backups naturally preserve both.
- This tranche does **not** implement automatic deletion or merging. The next issue #25 slice may delete empty childless notes retaining the default timestamp title, with preview and safety checks.

### Expansion semantics

Expansion state is persisted in `is_expanded`, but is not note activity.

Pre-v1 expansion values were not reliable persisted user state. The v0→v1 migration collapses them once. After v1, stored expansion state is authoritative and survives reopen.

Imports without an explicit expansion value start collapsed. TreeNote JSON preserves an explicit expansion value. Restoring a pre-v1 backup collapses legacy expansion values during restore; restoring v1+ preserves them.

Do not reset v1 expansion state on every open.

### Tree integrity

- New/add/move operations enforce a maximum of 20 levels.
- Existing/imported trees deeper than 20 levels must still open; do not destructively normalize them.
- A note cannot be moved under itself or its descendants.
- Sibling `sort_order` is maintained as a dense positional sequence after mutations.

## Search and performance

Search gets note data in one bulk Tauri/SQLite snapshot, then applies UI search/filter behaviour in React.

Large visible trees are currently expensive because the frontend renders all visible rows and the backend tree loader recursively walks the hierarchy. There is no virtualization layer. Do not mix a broad tree-performance rewrite into an unrelated issue.

When investigating tree performance, compare identical visible-row and expansion states. Persisted expansion can make the same top-level click reveal very different numbers of rows.

## Backups and restore

Managed backups are SQLite snapshots stored under the data-root backup area and use retention/lock metadata. Restore must preserve compatibility with legacy backups.

Important restore rule: the backup's schema version, not merely the columns it happens to contain, determines whether expansion state is authoritative. Pre-v1 restores normalize expansion to collapsed; v1+ restores preserve it.

Do not delete the backup being restored from.

## Development vs production

Use:

```bash
npm run tauri:dev
```

for normal development. The wrapper sets `TREENOTE_DEV_MODE=1`.

Production deliberately disables WebView developer tools/browser accelerator keys. Do not remove that production policy to make debugging easier; use the development wrapper instead.

The password feature is an application lock only. It does **not** encrypt the SQLite notebook.

## Issue workflow for agents

When given an issue and this repository with no other context:

1. Read the issue, this file, and the relevant code/tests before proposing changes.
2. Treat current `main` code and tests as the source of truth for implemented behaviour. If documentation conflicts with code, investigate before changing either.
3. For non-trivial work, identify the smallest affected subsystem and state the implementation approach before editing.
4. Work from current `main` on a dedicated branch unless the issue explicitly names an existing branch/PR.
5. Keep the change scoped to the issue. Do not bundle opportunistic refactors, performance work, or future sync work.
6. Preserve compatibility with existing notebooks, settings and backups unless the issue explicitly requires a migration.
7. Add focused regression tests for the bug/behaviour being changed.
8. Run the relevant test suites and report exactly what was run and what was not.
9. Open a PR against `main` with a concise description of behaviour, migration/compatibility consequences and validation. Do not merge unless explicitly instructed.

## Validation

CI on Windows runs:

```bash
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

and then:

```powershell
.\scripts\build_installer.ps1
```

For ordinary code changes, run frontend and Rust tests locally when possible. Run `npm run build` when TypeScript/build output is relevant. Installer/release changes require the Windows installer build; if your environment cannot run it, say so and rely on CI rather than claiming it passed.

Some tests manipulate process-global notebook state. If a group fails only together with a global SQLite/lock interaction, reproduce the failing tests individually before concluding the feature under test is broken; do not simply ignore a repeatable CI failure.

## Future direction: cloud sync

Cloud sync is **not implemented**. Do not add it incidentally.

The current architectural direction is optional, local-first sync using whole-notebook logical snapshots rather than turning every note edit into remote CRUD. The intended model includes:

- a stable logical notebook identity;
- append-only snapshots/history with ancestry rather than destructive last-writer replacement;
- a canonical hash of logical notebook state;
- install-specific sync bookkeeping kept outside the logical notebook state;
- a provider such as Google Drive appDataFolder so sync does not require users to manage ordinary Drive files.

Treat this as direction, not finished specification. A sync issue may refine it, but should not casually replace these assumptions without documenting the design decision.
