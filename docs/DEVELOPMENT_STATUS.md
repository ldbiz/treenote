# TreeNote development status and testing handoff

**Snapshot: 20 October 2026.** This file captures a decision and verified repository state, not a standing claim about future PR or CI status. Check GitHub before acting. See [AGENTS.md](../AGENTS.md) for product and implementation invariants and [DEVELOPERS.md](../DEVELOPERS.md) for build commands.

## What is on `main`

- `main` at the time of this snapshot is `7a9d2b5f500783e04d1d98cc3f1739271b9b7152` (merge of PR #34).
- Archive/lifecycle functionality and optional automatic inactive-branch archiving are merged. The **merged** SQLite schema is version **2**.
- CI tests the React/Vitest suite, Rust suite, and Windows installer build. There is **no reusable automated GUI/end-to-end test harness against the actual running Windows Tauri/WebView2 app** yet.

## Unmerged feature: manual empty-note cleanup (issue #25)

- **[Draft PR #35](https://github.com/ldbiz/treenote/pull/35)**: `feat/housekeeping-safe-empty-note-cleanup-25` -> `main`. Last observed feature head: `ca94cf6da3c479563b419ba481d19fc2bf1420d9`.
- **Still open, draft and unmerged** on this date. [Issue #25](https://github.com/ldbiz/treenote/issues/25) also remains open. Do not merge or close either without explicit approval.
- Only on the feature branch: schema **v3** adds explicit `generated_title_untouched` provenance, never inferred for legacy or imported notes. The cleanup is **manual only**, via the separate housekeeping review window, with frozen groups of 20, per-note selection and a destructive-action confirmation.
- Candidates must be original generated timestamp-title, **exactly empty**, childless leaves with sufficiently old, trustworthy lifecycle/activity fields and no effective archive state. A verified, locked and labelled managed SQLite safety backup must succeed **before** any deletion. Execution revalidates inside a transaction, deletes individual leaves (not subtrees), compacts sibling ordering, and refreshes the main UI. Changed candidates are skipped.
- These are **implementation claims to verify on the actual app**, not acceptance-test results. They do not describe what is already available on `main`.
- **CI verified:** [Windows run #39158427547](https://github.com/ldbiz/treenote/actions/runs/39158427547) completed successfully: frontend tests, Rust tests, and Windows installer build all passed. **No real-desktop GUI acceptance test has been performed or passed.** See the PR checklist for scenarios, including negative cases.
- PR #35's branch updates `AGENTS.md` and `DEVELOPERS.md` to document v3. Those descriptions must not be treated as merged `main` behaviour until PR #35 is merged. Reconcile this status file and documentation when that happens.

## Decision: build a small reusable GUI test harness before accepting PR #35

The owner elected **not** to do PR #35's large checklist manually first. Build the smallest viable **general-purpose, permanent** Windows GUI/E2E test capability, then use PR #35 as its first substantial regression suite. Avoid a comprehensive framework built speculatively.

**Job 1 — standalone harness PR from current `main`:**

1. Read the repository and current Tauri v2 / Windows automation documentation before selecting tooling. Consider WebDriverIO + Tauri integration / WebDriver-based WebView2 control; prove that it attaches to **TreeNote's actual Tauri window**, not a normal Chromium tab showing `http://localhost:1420`. Evaluate compatibility and CI before committing to a driver; avoid relying on coordinates for in-WebView actions.
2. Launch a real Windows TreeNote instance with a disposable, absolute data root. On Windows TreeNote normally resolves the root through `HKCU\Software\TreeNote\DataRoot`, otherwise platform app-data; **there is currently no test environment-variable override**. Prefer an isolated Windows CI user/runner or VM. If registry override is required, verify isolation, preserve/restore its original value, and fail closed rather than risk a real notebook. Never run destructive tests against ordinary installed user data.
3. Prove one complete, reproducible **create -> edit -> restart -> verify persistence** GUI smoke test using the real database/backend. Add narrow diagnostics (screenshots/logs on failure), cleanup and basic Windows CI integration. If the hosted CI runner cannot operate an interactive desktop, report the blocker and a modest alternative instead of broadening scope indefinitely.
4. Keep fast Vitest/Rust tests separate. The harness must be easy for future agents to extend for new features; document setup and how to run it. Do not weaken production WebView developer-tools restrictions.
5. Handle genuine **native Windows dialogs** through a narrowly scoped desktop helper if necessary (e.g. AutoHotkey), rather than coordinate-clicking the WebView or adding a test-only in-page confirmation. First establish whether the selected driver can handle actual multiwindow navigation and native dialogs.
6. Open a dedicated PR. Do not merge without approval, and do not modify PR #35's feature code merely to make the first smoke test possible.

**Job 2 — use that harness to test PR #35 against its own branch:**

- Exercise the separate `TreeNote — Housekeeping review` Tauri window and real confirmation dialog.
- Use isolated, deterministic fixtures; the minimum inactivity threshold is one day, so suitable notes need deliberately aged timestamps before preview.
- Cover fixed groups of 20, kept/unchecked notes, cancellation with no deletion or safety backup, successful locked/labelled backup before deletion, failed backup blocking deletion, post-scan changes skipped, tree/search refresh and notebook switching, unsaved editor changes, restore/provenance and sibling order. Assert actual SQLite contents and backup metadata, not just UI appearance.
- Prefer deterministic failure injection *at the test boundary* when feasible; do not introduce production-only test flags that bypass the real destructive workflow. Use narrowly scoped native-dialog automation only where necessary.
- Retain the resulting GUI cases as normal regressions for future PRs. Report exactly what was and was not demonstrated. If the basic harness proves disproportionately difficult, stop and ask for a decision rather than expanding the project.

**Acceptance gate:** PR #35 remains unmerged until its destructive workflow has been exercised against the running app, its backing files have been verified, and the owner approves merging. A short owner usability check can remain at the end; there is no requirement for them to execute the entire manual checklist upfront.
