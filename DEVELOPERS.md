# Technical Information

For coding-agent operating rules and product invariants, read [AGENTS.md](AGENTS.md) first.

## Stack

- **Shell**: Tauri (Rust backend, web frontend)
- **Frontend**: React, TypeScript, Fluent UI
- **Storage**: SQLite
- **State**: React hooks

TreeNote on Windows uses the Microsoft Edge WebView2 runtime. It is pre-installed on most Windows 10 (20H2 and later) and Windows 11 systems. If the app fails to start on an older system, install WebView2 from [Microsoft](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

## Run from source

Prerequisites: [Node.js](https://nodejs.org/) (LTS), [Rust](https://www.rust-lang.org/tools/install), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
npm run setup
npm run tauri:dev
```

Use `npm run tauri:dev`, not a bare `npm run tauri dev`, for normal development. The wrapper sets `TREENOTE_DEV_MODE=1`, which keeps production-only WebView restrictions out of the development build.

`npm run dev`, `npm run build`, and `npm run tauri` all run a small dependency check first and call `npm install` if `node_modules` is missing.

## VS Code / Cursor debugging

Use the **Tauri Development Debug** launch configuration in `.vscode/launch.json`. It starts the Vite dev server (`ui:dev` task) before attaching the Rust debugger and sets `TREENOTE_DEV_MODE=1`.

The production build deliberately disables WebView developer tools and browser accelerator keys. Do not weaken that production policy for debugging.

## Project layout

- `src/` — React frontend
- `src/App.tsx` — top-level application state/coordination
- `src/components/Tree.tsx` — tree interaction/rendering, filtering and archive visibility
- `src/components/TextPanel.tsx` — editor and search
- `src/lib/tree.ts` — frontend wrappers around Tauri tree commands
- `src/lib/treeDepth.ts` — shared 20-level nesting cap (`MAX_TREE_LEVEL`)
- `src-tauri/` — Rust backend
- `src-tauri/src/main.rs` — backend entry point and Tauri commands
- `src-tauri/src/tree.rs` — tree data structures/serialization
- `src-tauri/src/storage.rs` — schema/migrations, database operations, settings, notebook switching and restore
- `src-tauri/src/data_root.rs` — data-root resolution and standard folder layout
- `src-tauri/src/managed_notebook.rs` — managed notebook path/name validation
- `src-tauri/src/backup.rs` / `backup_meta.rs` — managed backup retention/metadata
- `src-tauri/src/convert/` — import/export formats
- `installer/` — Inno Setup script for the Windows installer
- `scripts/build_installer.ps1` — builds the app and packages the installer

## Storage model

TreeNote's configured data root contains `notebooks/`, `backups/`, `exports/` and `settings.json`. One notebook is active per running app instance. Ordinary notebook creation/switching is limited to managed `.sqlite3` files directly inside `notebooks/`.

The current notes schema is version 2 and contains hierarchy, plain-text content, persisted expansion state, lifecycle/archive metadata, local `last_accessed_at` and logical `last_unarchived_at`. Automatic inactive-branch archiving is optional; manual preview and execution are available in Settings → Housekeeping. The default inactivity threshold is 90 days. Legacy creation/modification timestamps remain `NULL` rather than being invented. See [AGENTS.md](AGENTS.md) for the invariants around migrations, `modified_at`, archive inheritance and expansion persistence.

The app-lock password protects UI access only; the SQLite file itself is not encrypted.

## Performance characteristics

The current backend tree load is recursive and the frontend renders all visible tree rows; there is no virtualization layer. For performance investigations, compare identical visible-row and expansion states before attributing a regression to per-row rendering.

Search content is loaded through a bulk backend snapshot rather than one IPC call per note.

## Tests

Frontend:

```bash
npm test
```

Rust:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

TypeScript/frontend build:

```bash
npm run build
```

CI runs frontend tests, Rust tests and the Windows installer build on every pull request to `main`.

## Build the app binary

```bash
npm run tauri build -- --no-bundle
```

Output is `src-tauri/target/release/treenote.exe`.

## Build the Windows installer

Install [Inno Setup 7](https://jrsoftware.org/isinfo.php), then run:

```powershell
.\scripts\build_installer.ps1
```

Or:

```bash
npm run tauri:build
```

The script finds `ISCC.exe` on `PATH` or in standard install locations. For a custom location, set `ISCC_PATH` to the full compiler path first.

The script builds the Tauri app first, then writes the installer to `dist/installer/treenote-0.2.1-setup.exe`.

## Releasing

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
2. Commit the version bump.
3. Push a tag matching the version, for example `v0.2.2`.
4. GitHub Actions builds the installer and creates a draft release. Publish it from the Releases page.

You can also build locally and upload the installer to a GitHub release manually.
