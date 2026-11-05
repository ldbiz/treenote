# Optional cross-device sync — proposed design/implementation plan

**Proposal dated 28 October 2026. Not implemented, not yet approved.** Tracks [GitHub issue #5](https://github.com/ldbiz/treenote/issues/5). Read [development status](DEVELOPMENT_STATUS.md) and [agent invariants](../AGENTS.md) first. Keep this small and local-first.

## Goal and user contract

Make the *same logical notebook* accessible on two Windows installations, optionally linked using a Google account, without risking an unintentional overwrite or requiring cloud access to use TreeNote.

- **Default:** sync off; app remains entirely usable offline. Backups remain local and independent of sync. One active notebook per application instance remains the existing rule.
- Explicitly choose a notebook to sync; other local notebooks stay untouched. Clear status: local-only, up-to-date, syncing, offline/error, or **conflict needs attention**.
- No background service when TreeNote is not running. Flush autosaved edits before taking snapshots or switching state. Do not present a sync operation as a backup.
- An initial version must preserve both sides of divergence and make recovery understandable. No automatic destructive conflict resolution or silent last-writer-wins. A note deleted locally is an intentional state change; it must not be mistaken for a missing upload.
- The initial release does **not** require simultaneous real-time collaborative editing, multi-user sharing, per-keystroke remote CRUD, a cross-platform port, nor merge of independently modified note trees.

## First architecture decision: logical snapshots, not SQLite-file copying

1. Give notebooks a stable **logical identity** independent of the local path/file and installation. Define a migration for existing v3 databases without changing established note IDs.
2. Canonicalize logical notebook state (stable node IDs, parent/order, content, labels, relevant lifecycle/archive and provenance fields). Include v3 `generated_title_untouched` and logical deletions; exclude `last_accessed_at`, local housekeeping schedules, caches, backup files, locks and install/account data. Agree precise timestamp and expansion handling before freezing the hash.
3. Persist immutable **versioned logical snapshots** with parent revision IDs and a deterministic content hash. Keep local sync bookkeeping outside logical notebook data. A remote manifest/head points at the current revision; retain enough ancestry and snapshot history for conflict recovery.
4. Compare remote and local ancestry before applying any update: same state → no-op; ancestor on one side → safe fast-forward; diverged histories → **stop, preserve both, expose an explicit resolution/recovery flow**. This is initially notebook-level conflict detection, not clever note-by-note merge. Uploads need a safe head-update/concurrency check; re-read and handle races rather than assuming no other device wrote.
5. Apply an incoming snapshot only after validation plus an appropriate **pre-apply local backup**, with atomic transaction/rollback semantics. Recovery must be possible if network, auth, process or disk fails partway through. Migration/restore and sync revision ancestry must be defined together.

## Provider proposal and security limits

- **First provider candidate:** Google Drive **appDataFolder**, limited to the app's own hidden files with the `drive.appdata` scope. Confirm API and quota/behaviour while planning. This folder is not a user-browsable backup folder and can be removed by the user; keep independent local backups.
- Native desktop OAuth: system browser, Authorization Code + **PKCE** and desktop loopback redirect. Keep refresh tokens in Windows credential-protected storage, **not** SQLite/settings, source files or logs. No client secret embedded in a public desktop app can be treated as confidential.
- Give a clear opt-in privacy explanation: plain-text note content would be sent to the user's Google account; hidden app data is **not end-to-end encryption**. Network, sign-out, token revocation and account mismatch must fail safely; never silently create a second cloud state with the same notebook identity.
- Separate provider-specific transport/auth from logical serialization, revision verification and conflict handling, so the first tests do **not** require a Google account.

Google reference documentation:
- https://developers.google.com/workspace/drive/api/guides/appdata
- https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- https://developers.google.com/identity/protocols/oauth2/native-app

## Staged delivery (each stage separately reviewable)

**S0 — design review only (first approval gate).** Inspect current v3 schema, JSON import/export, locks, restores and housekeeping activity. Write down the canonical state contract, exact snapshot/version schema, manifest concurrency mechanism, conflict/recovery UX, backup semantics, and size limits. Decide whether Google Drive is viable as the first provider; explicitly avoid a provider abstraction framework unless a second provider is demonstrably needed.

**S1 — local sync core (no cloud or OAuth).** Implement version identity/canonical serialization, revision ancestry, read/write integrity checks, fast-forward, divergence detection, atomic apply and backup/restore behaviour behind narrow Rust interfaces. Test with **two isolated local notebook installations** and a simulated remote directory. No new end-user UI beyond what is necessary for local diagnostics.

**S2 — Google Drive transport and opt-in UI.** Add desktop OAuth, secure token storage, `appDataFolder` snapshot/manifest IO, scoped sync settings/status, explicit link/unlink, safe resume after disconnection and error reporting. Do not alter existing local backup tiers or overwrite an existing notebook merely because the same name appears remotely.

**S3 — two-device acceptance and polish.** Independently verify offline edits on both devices, ancestry fast-forward, diverged revisions, deletion vs edits, note reorder/archive/provenance, sign-out/reconnect, interrupted upload/apply, restore of old backups and prevention of silent data loss. Use bounded manual GUI checks and focused Rust/frontend tests; **do not revive the cancelled GUI test harness**.

## Decision gates before any code

Owner approval is needed on: (a) starting S0, (b) notebook-level **conflict = stop and choose/recover** rather than automatic merging for v1, and (c) initial Google account storage without end-to-end encryption. Do not request Google credentials or set up an OAuth app until S1 has demonstrated sound snapshot/recovery semantics.

**Non-goal:** No automatic destructive housekeeping as part of sync. Consider ordinary version-history UI only if needed for understandable conflict recovery.
