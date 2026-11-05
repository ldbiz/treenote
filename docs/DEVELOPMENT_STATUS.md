# TreeNote development status

**Verified 28 October 2026, after PR #35 merged at 19:45 UTC.** GitHub `main`, current PR status and tests are authoritative if this dated snapshot is overtaken. [Project rules](../AGENTS.md) · [Build/development](../DEVELOPERS.md) · [Proposed sync plan](SYNC_DESIGN_PLAN.md).

## Merged product baseline

- Local-first Windows desktop note tree: Tauri/Rust, React/TypeScript, SQLite; plain-text content, managed notebooks, autosave, search/filter, drag/drop, JSON/conversion, backup/restore, undo/redo and persisted tree expansion.
- [PR #30](https://github.com/ldbiz/treenote/pull/30): lifecycle metadata, explicit archive/unarchive and inherited archive visibility.
- [PR #34](https://github.com/ldbiz/treenote/pull/34): last-access tracking, optional automatic inactive-branch archiving, a standalone Housekeeping review with fixed 20-item groups.
- **[PR #35](https://github.com/ldbiz/treenote/pull/35) merged 28 Oct:** conservative **manual-only** deletion of old, originally auto-titled, truly empty childless leaves. Verified locked/labelled safety backup, explicit confirmation and transactionally revalidated single-row deletion. Current `main` SQLite **schema v3**, including `generated_title_untouched`. The feature was manually tested and merged by the owner; Windows frontend/Rust/installer CI also passed.
- Automatic archiving **never intentionally performs deletion**. No cloud sync, automated empty-note deletion or merging of nonempty notes exists.

## Closed/cancelled work and documentation

- [PR #37](https://github.com/ldbiz/treenote/pull/37) was closed **unmerged** 28 October. The experimental native Windows GUI harness proved disproportionate to its immediate value; do not restart it as a prerequisite for housekeeping, sync or future PRs. Use targeted Rust/frontend automation and bounded manual Windows acceptance.
- [PR #36](https://github.com/ldbiz/treenote/pull/36) was a 20–27 October historical GUI-testing handoff based on pre-v3 `main`. Its plan is superseded by this document; do **not** merge its stale content.
- The [PR #35 acceptance checklist](https://github.com/ldbiz/treenote/pull/35) still shows two **unchecked** items (restore from a pre-v3 backup/v3 backup provenance, and ensure automatic archiving does not trigger deletion) despite merge. This is a documentation/evidence gap, **not a reported defect**. Confirm if performed, or cover these during a future bounded regression pass; never claim the checkboxes passed without evidence.
- [Issue #25](https://github.com/ldbiz/treenote/issues/25) is an umbrella backlog item. Its archiving and conservative manual cleanup portions have shipped. Possible *merging of unvisited, nonempty notes* and automatic deletion remain explicitly **deferred**, not committed work. Recommend closing or narrowing the umbrella after deciding whether there is a real use case, rather than expanding destructive housekeeping by default.

## Development priorities (proposal, not approval to implement)

1. **Close the housekeeping tranche:** resolve this documentation handoff, capture any residual safety-test evidence, and decide whether to close issue #25 with the nonempty-note merging idea deferred.
2. **Small independent bug fixes if useful:** [#32 right-click Copy loses selection](https://github.com/ldbiz/treenote/issues/32) and other reproducible UI bugs can get focused PRs. Do not turn these into blockers for major planning.
3. **Next substantive feature: [optional sync #5](https://github.com/ldbiz/treenote/issues/5)**. Design and test the sync protocol **before** adding Google OAuth or a settings UI. [SYNC_DESIGN_PLAN.md](SYNC_DESIGN_PLAN.md) is a staged proposal requiring owner approval, not an implementation instruction.
4. Maintain product discipline: local-first and plain text; no mandatory account; no broad rewrite, elaborate GUI automation framework, automatic destructive cleanup, or incidental AI/rich-text feature.

## Hand-off to the next agent

Before writing sync code, inspect actual `main` v3 migrations, TreeNote JSON serialization, backup/restore and note deletion semantics; validate the proposed snapshot identity, canonical hashing, ancestor/conflict handling and recovery tests. Preserve local `last_accessed_at`, scheduling and install-specific settings outside logical sync; retain v3 `generated_title_untouched` as logical provenance. Write a focused design decision into issue #5 / sync plan, identify acceptance tests, then open a bounded PR from current `main`. Never implement silent last-writer-wins overwrites.

All application changes still require owner approval to merge.
