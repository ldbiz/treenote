// Real Windows Tauri/WebView2/SQLite smoke: UI create/edit, close, restart, verify.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { startWdioSession, cleanupWdioSession } from "@wdio/tauri-service";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(testDir, "..");
const binary = resolve(repoRoot, "src-tauri", "target", "debug", "treenote.exe");
const markerName = ".treenote-gui-test-root";
const content = "TreeNote GUI smoke: persistent edit from real Windows WebView2";
const artifacts = join(testDir, "artifacts");
let runRoot, marker, browser, failed = false;

function assertWithin(child, parent) {
  const part = relative(parent, child);
  assert(part && part !== ".." && !part.startsWith("..\\") &&
    !part.startsWith("../") && !isAbsolute(part), "path escaped disposable data root");
}

function readNotes(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    return db.prepare("SELECT id, label, content FROM notes ORDER BY rowid").all();
  } finally {
    db.close();
  }
}

async function assertIsolatedNotebook() {
  const expected = join(runRoot, "notebooks", "treenote.sqlite3");
  const settings = JSON.parse(await fs.readFile(join(runRoot, "settings.json"), "utf8"));
  const resolvedDb = await fs.realpath(expected);
  assertWithin(resolvedDb, runRoot);
  // Both values must refer to the identical existing file (not just look
  // similar as strings; Windows may canonicalize paths with a device prefix).
  const actualDb = await fs.realpath(settings.database_path);
  assert.equal(actualDb.toLowerCase(), resolvedDb.toLowerCase(),
    "TreeNote opened an unexpected notebook");
  return expected;
}

async function openSession() {
  return startWdioSession({
    browserName: "tauri",
    "tauri:options": { application: binary },
    "wdio:tauriServiceOptions": {
      driverProvider: "official",
      autoInstallTauriDriver: true,
      autoDownloadEdgeDriver: true,
      startTimeout: 60000,
      logDir: artifacts
    }
  });
}

async function closeSession() {
  if (!browser) return;
  const active = browser;
  browser = undefined;
  await cleanupWdioSession(active);
}

async function screenshot(stage) {
  if (!browser) return;
  try {
    await fs.mkdir(artifacts, { recursive: true });
    const filename = join(artifacts, "smoke-" + stage + ".png");
    await browser.saveScreenshot(filename);
    console.error("Screenshot:", filename);
  } catch (error) { console.error("Screenshot unavailable:", error); }
}

async function main() {
  assert.equal(process.platform, "win32", "The native GUI harness must run on Windows");
  assert(existsSync(binary), "Build the debug Tauri binary first: " + binary);
  assert(!process.env.TREENOTE_GUI_TEST_DATA_ROOT && !process.env.TREENOTE_GUI_TEST_TOKEN,
    "Refusing to replace pre-existing GUI-test isolation environment variables");
  runRoot = await fs.mkdtemp(join(tmpdir(), "treenote-gui-test-"));
  assert.equal(resolve(runRoot), runRoot);
  assert(basename(runRoot).startsWith("treenote-gui-test-"));
  marker = randomBytes(32).toString("hex");
  await fs.writeFile(join(runRoot, markerName), marker + "\n", { flag: "wx" });
  process.env.TREENOTE_GUI_TEST_DATA_ROOT = runRoot;
  process.env.TREENOTE_GUI_TEST_TOKEN = marker;
  process.env.WEBVIEW2_USER_DATA_FOLDER = join(runRoot, "webview2");
  await fs.mkdir(artifacts, { recursive: true });
  const dbPath = join(runRoot, "notebooks", "treenote.sqlite3");
  assert(!existsSync(join(runRoot, "settings.json")) && !existsSync(dbPath));
  console.log("Disposable TreeNote root:", runRoot);
  console.log("First native application launch");
  browser = await openSession();
  try {
    const add = await browser.$('button[aria-label="New Tree"]');
    await add.waitForClickable({ timeout: 20000 });
    await add.click();
    const editor = await browser.$("#note-editor");
    await editor.waitForEnabled({ timeout: 10000 });
    await editor.setValue(content);
    assert.equal(await editor.getValue(), content);
    await assertIsolatedNotebook();
    await browser.waitUntil(() => {
      try {
        const rows = readNotes(dbPath);
        return rows.length === 1 && rows[0].content === content;
      } catch { return false; }
    }, { timeout: 15000, interval: 300, timeoutMsg: "edit did not persist to SQLite" });
    console.log("Verified SQLite edit before restart");
  } catch (e) { await screenshot("first-launch"); throw e; }
  finally { await closeSession(); }

  assert.equal(readNotes(dbPath).length, 1);
  console.log("Second native application launch (same notebook)");
  browser = await openSession();
  try {
    const note = await browser.$('[role="treeitem"]');
    await note.waitForExist({ timeout: 20000 });
    await note.click();
    const editor = await browser.$("#note-editor");
    await editor.waitForEnabled({ timeout: 10000 });
    await browser.waitUntil(async () => (await editor.getValue()) === content, {
      timeout: 10000, timeoutMsg: "saved content did not reload into editor"
    });
    assert.equal(await editor.getValue(), content);
    await assertIsolatedNotebook();
    const rows = readNotes(dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, content);
    console.log("PASS: native UI create/edit/restart plus SQLite persistence");
  } catch (e) { await screenshot("restart"); throw e; }
  finally { await closeSession(); }
}

try { await main(); }
catch (error) {
  failed = true;
  process.exitCode = 1;
  console.error("FAIL: native GUI smoke:", error);
} finally {
  try { await closeSession(); }
  catch (error) {
    failed = true; process.exitCode = 1;
    console.error("GUI session cleanup failed:", error);
  }
  if (runRoot) {
    try {
      assert.equal((await fs.readFile(join(runRoot, markerName), "utf8")).trim(), marker);
      assert.equal(resolve(runRoot, ".."), resolve(tmpdir()));
      if (!failed) {
        await fs.rm(runRoot, { recursive: true, force: false });
        console.log("Disposable test data removed");
      } else {
        console.error("Retained failed test data for investigation:", runRoot);
      }
    } catch (error) {
      process.exitCode = 1;
      console.error("Safe cleanup blocked:", error);
    }
  }
}
