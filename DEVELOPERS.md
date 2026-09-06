# Technical Information

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
npm run tauri dev
```

`npm run dev`, `npm run build`, and `npm run tauri` all run a small check first and call `npm install` if `node_modules` is missing.

## VS Code / Cursor debugging

Use the **Tauri Development Debug** launch configuration in `.vscode/launch.json`. It starts the Vite dev server (`ui:dev` task) before attaching the Rust debugger.

## Project layout

- `src/` — React frontend
- `src-tauri/` — Rust backend
- `src-tauri/src/main.rs` — backend entry point
- `src-tauri/src/tree.rs` — tree data structures
- `src-tauri/src/storage.rs` — database operations
- `installer/` — Inno Setup script for the Windows installer
- `scripts/build_installer.ps1` — builds the app and packages the installer

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

The script builds the Tauri app first, then writes the installer to `dist/installer/treenote-0.1.0-setup.exe`.

## Releasing

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
2. Commit the version bump.
3. Push a tag matching the version, for example `v0.1.0`.
4. GitHub Actions builds the installer and creates a draft release. Publish it from the Releases page.

You can also build locally and upload the installer to a GitHub release manually.
