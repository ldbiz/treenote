# TreeNote development status and next decision

**Verified snapshot: 27 October 2026.** GitHub `main`, open PRs and CI are authoritative; this document records the current development path, not an automatic claim of test completion. For stable code/product invariants consult [AGENTS.md](../AGENTS.md); for commands consult [DEVELOPERS.md](../DEVELOPERS.md).

## Shipped on `main`

- TreeNote is a local-first React/Tauri/SQLite plain-text tree editor with notebook selection, autosave, backups/restore, import/export, search/filter, and tree management.
- [PR #30](https://github.com/ldbiz/treenote/pull/30) shipped lifecycle metadata, persisted expansion and manual/inherited archiving; [PR #34](https://github.com/ldbiz/treenote/pull/34) shipped inactivity metadata, optional automatic inactive-branch archiving and the separate Housekeeping review window with fixed groups of 20.
- **Current merged SQLite schema is v2.** Do not represent unmerged v3 capabilities as shipped.
- Windows CI runs frontend tests, Rust tests and installer build. These are not proof of real Tauri/WebView2 GUI acceptance.

## Unmerged PRs and validation status

| PR | State on 27 Oct | Significance / outstanding gate |
| --- | --- | --- |
| [#35](https://github.com/ldbiz/treenote/pull/35) | Open draft, unmerged | Manual cleanup of aged, truly empty, childless notes with untouched generated timestamp titles. Adds schema **v3** provenance. Transactional revalidation and a verified locked safety backup must precede deletion. [Windows CI run 39158427547](https://github.com/ldbiz/treenote/actions/runs/39158427547) passed, but **real desktop destructive-workflow acceptance has not been established**. |
| [#36](https://github.com/ldbiz/treenote/pull/36) | Open, documentation only | This handoff; update independently of implementation. Earlier 20 Oct automation-first direction and 25 Oct closure comments are historical, superseded by this dated snapshot. |
| [#37](https://github.com/ldbiz/treenote/pull/37) | Reopened open draft; **experimental, unmerged** | Implements isolated debug-only Windows native GUI smoke runner (WebdriverIO/Tauri), for real create/edit/restart/SQLite persistence. Standard CI passed, including [run 40228483773](https://github.com/ldbiz/treenote/actions/runs/40228483773). Hosted experimental GUI runs were cancelled; an earlier run failed to establish a WebDriver session (`DevToolsActivePort file doesn't exist`). No successful real Windows smoke is evidenced yet. **Do not merge on CI status alone.** |

PR #35 eligibility is intentionally conservative: legacy/imported notes are excluded; edited, renamed, recently active, archived, nonempty or descendant-bearing notes should not qualify. A fixed review snapshot uses 20-note groups; each deletion requires explicit confirmation; failure of the managed locked safety backup must prevent deletion; stale candidates are skipped. Automatic archiving never deletes. Keep [umbrella issue #25](https://github.com/ldbiz/treenote/issues/25) open after this slice.

## Immediate decision: narrowly evaluate PR #37, not a GUI automation programme

The 20 October proposal to build an extensive GUI acceptance harness was reconsidered on 25 October as potentially disproportionate. PRs #36 and #37 were subsequently reopened for a **bounded local Windows/Cursor evaluation**; reopening is *not* approval for a large automation project.

1. On a Windows development machine, check out PR #37 and follow [gui-tests/README.md](https://github.com/ldbiz/treenote/blob/test/windows-tauri-gui-smoke/gui-tests/README.md). Confirm isolation uses an explicitly disposable test data root and never an existing notebook. Run the minimal real desktop create/edit/restart/SQLite smoke and capture command, exit status and failure diagnostics. Do not run destructive tests against personal notebooks.
2. Review the outcome and maintenance/driver complexity. If the smoke runs repeatably without material environment-specific work, consider keeping a **small reusable smoke test only**. Do *not* automatically expand into complex multi-window/native-dialog/destructive-cleanup automation.
3. If the basic smoke is unreliable or requires substantial Windows driver/desktop infrastructure, **stop** and close #37 unmerged after recording evidence. Continue with focused Rust/frontend regression coverage and a bounded manual acceptance pass for #35.
4. Either way, #35 still needs a real desktop user-workflow check and explicit approval before merge. Its backup, restore and exclusions are too consequential to accept based solely on CI. #36 can be reviewed as documentation independently, but documentation approval must not implicitly approve #35 or #37.

## PR #35 acceptance scope (disposable notebook only)

- Positive case: deliberately age several genuinely untouched empty UI-generated leaf notes, review fixed groups, uncheck some and delete only confirmed eligible notes. Inspect SQLite rows, sibling order, current tree/search refresh and selected-note state.
- Negative cases: edited-then-cleared, renamed-then-restored, whitespace-only, imported/legacy, recently used, nonempty, archived or child-bearing notes must stay; cancellation must cause no deletion or extra safety backup.
- Safety: confirm labelled **locked verified** pre-deletion backup and successful restore. Revalidate a candidate modified after the scan; fail safely if backup cannot be created. Backend failure injection can be tested at Rust level when GUI setup would be artificial. Confirm automatic archive never deletes notes.
- Existing automated checks, exact scenarios tested, remaining risks and observed GUI behaviour should be recorded on PR #35; fix any defects on its feature branch. Merge **only with explicit owner approval**.

## After #35

1. Settle #35 first, merge only after acceptance, then update `AGENTS.md`/`DEVELOPERS.md` and this status from v2 to the actually merged schema. Close stale #36/#37 PRs as appropriate; do not leave contradictory handoff instructions.
2. Review the residual scope of [issue #25](https://github.com/ldbiz/treenote/issues/25): old nonempty-note merging is only an idea and carries data-loss risk. Prefer deliberately deferring or scoping it rather than beginning speculative destructive housekeeping.
3. Address small reproducible UX defects (e.g. [#32 Copy deselects text](https://github.com/ldbiz/treenote/issues/32)) in focused PRs when useful.
4. Next substantive capability for a separate architecture review: [optional cross-device sync #5](https://github.com/ldbiz/treenote/issues/5). It is **not implemented**. Prior direction: opt-in local-first logical whole-notebook snapshots with ancestry/history, stable notebook identity, install-local sync bookkeeping, conflict/recovery design and a possible Google Drive appDataFolder provider. Keep local backups independent. Do not mix sync with #35 or #37.
5. Preserve TreeNote's deliberately simple plain-text/local-first product scope. AI integration and richer formatting remain separate potential future features, not prerequisites.

**Working principle:** use targeted automated unit/integration tests for correctness; add desktop GUI automation only where its demonstrated reliability and future reuse justify maintenance. A manual check is preferable to an expansive flaky test platform.
