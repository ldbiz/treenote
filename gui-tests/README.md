# Native Windows GUI tests

This is an initial **real application** WebdriverIO/Tauri v2 WebView2 smoke
test, not browser-mode testing of Vite and not a mocked Rust backend.

## Run (Windows, Node 24+)

From repository root:

    npm ci
    npm run build
    cargo build --manifest-path src-tauri/Cargo.toml
    npm install --prefix gui-tests
    npm --prefix gui-tests run smoke

The debug executable is `src-tauri/target/debug/treenote.exe`. The first run
may install `tauri-driver` and download a compatible Edge WebDriver. A working
Windows Tauri/Rust build environment is required. Do not run the release
executable for this smoke test.

The runner creates a fresh `%TEMP%/treenote-gui-test-<random>`, writes a
random marker and sets `TREENOTE_GUI_TEST_DATA_ROOT`,
`TREENOTE_GUI_TEST_TOKEN` and `WEBVIEW2_USER_DATA_FOLDER` in the launcher
environment. The Rust debug-only override refuses invalid, unmarked or
non-temp paths instead of falling back to HKCU DataRoot. The launcher skips
repairing the Windows autostart registry entry in test mode; no registry
configuration is changed.

The real application creates its usual SQLite notebook in the disposable
root. WebdriverIO clicks New Tree, edits its textarea, waits for the SQLite
write, closes the app, starts a fresh app session, selects the note, checks
its content, and rechecks SQLite integrity and the configured database path.

Successful runs delete only the marker-validated disposable root. Failures
retain that root for investigation; screenshots and driver logs go to
`gui-tests/artifacts/` (ignored by git). Do not upload personal notebooks.
Treat output as unverified until **executed successfully** on Windows.

The dedicated Windows GitHub-hosted job is experimental; the ability to
build a Windows executable does not establish interactive desktop GUI support.

## Extending

Keep semantic WebDriver locators for WebView controls, with backend/SQLite
assertions when needed. Do not replace user interactions with mocked invoke
calls. New tests must use the isolated data root and cleanup safeguards.

For PR #35, add the standalone housekeeping window and safety-backup cases
only **after this smoke test succeeds**. Use Tauri window handles for extra
webviews. Native Windows dialogs may need a very small separate UI Automation
helper, not screen-coordinate clicking. Prefer focused backend tests for
failure injection rather than changing production confirmation dialogs.
