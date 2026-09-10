import { confirm as showConfirm, message as showDialogMessage, open, save } from "@tauri-apps/plugin-dialog";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function showMessage(
  message: string,
  options?: { title?: string; kind?: "info" | "warning" | "error" }
): Promise<void> {
  if (isTauriRuntime()) {
    try {
      await showDialogMessage(message, {
        title: options?.title ?? "TreeNote",
        kind: options?.kind ?? "info",
      });
      return;
    } catch (error) {
      console.error("Message dialog failed:", error);
    }
  }
  window.alert(message);
}

export async function pickSqliteNotebook(
  defaultPath?: string
): Promise<string | null> {
  if (isTauriRuntime()) {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        defaultPath,
        filters: [
          {
            name: "TreeNote notebook",
            extensions: ["sqlite3", "sqlite", "db"],
          },
        ],
      });
      if (typeof selected === "string") return selected;
      return null;
    } catch (error) {
      console.error("Notebook picker failed:", error);
      return null;
    }
  }
  const path = window.prompt("TreeNote notebook path", defaultPath ?? "");
  return path?.trim() ? path.trim() : null;
}

export async function pickFlashnoteDatabase(
  defaultPath?: string
): Promise<string | null> {
  if (isTauriRuntime()) {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        defaultPath,
        filters: [
          {
            name: "Flashnote database",
            extensions: ["db", "sqlite", "sqlite3"],
          },
        ],
      });
      if (typeof selected === "string") return selected;
      return null;
    } catch (error) {
      console.error("Flashnote picker failed:", error);
      return null;
    }
  }
  const path = window.prompt("Flashnote database path", defaultPath ?? "");
  return path?.trim() ? path.trim() : null;
}

export async function pickNotebookSavePath(
  defaultPath?: string
): Promise<string | null> {
  if (isTauriRuntime()) {
    try {
      const selected = await save({
        defaultPath,
        filters: [
          {
            name: "TreeNote notebook",
            extensions: ["sqlite3"],
          },
        ],
      });
      return typeof selected === "string" ? selected : null;
    } catch (error) {
      console.error("Notebook save picker failed:", error);
      return null;
    }
  }
  const path = window.prompt("New TreeNote notebook path", defaultPath ?? "");
  return path?.trim() ? path.trim() : null;
}

export async function pickFlashnoteSavePath(
  defaultPath?: string
): Promise<string | null> {
  if (isTauriRuntime()) {
    try {
      const selected = await save({
        defaultPath,
        filters: [
          {
            name: "Flashnote database",
            extensions: ["db"],
          },
        ],
      });
      return typeof selected === "string" ? selected : null;
    } catch (error) {
      console.error("Flashnote save picker failed:", error);
      return null;
    }
  }
  const path = window.prompt("Flashnote database path", defaultPath ?? "");
  return path?.trim() ? path.trim() : null;
}

export async function pickTreenoteJsonFile(
  defaultPath?: string
): Promise<string | null> {
  if (isTauriRuntime()) {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        defaultPath,
        filters: [{ name: "TreeNote JSON", extensions: ["json"] }],
      });
      if (typeof selected === "string") return selected;
      return null;
    } catch (error) {
      console.error("TreeNote JSON picker failed:", error);
      return null;
    }
  }
  const path = window.prompt("TreeNote JSON path", defaultPath ?? "");
  return path?.trim() ? path.trim() : null;
}

export async function pickJsonExportPath(
  defaultPath?: string
): Promise<string | null> {
  if (isTauriRuntime()) {
    try {
      const selected = await save({
        defaultPath,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      return typeof selected === "string" ? selected : null;
    } catch (error) {
      console.error("Export path picker failed:", error);
      return null;
    }
  }
  const path = window.prompt("Export JSON path", defaultPath ?? "");
  return path?.trim() ? path.trim() : null;
}

export async function pickBackupFolder(
  defaultPath?: string
): Promise<string | null> {
  if (isTauriRuntime()) {
    try {
      const selected = await open({
        multiple: false,
        directory: true,
        defaultPath,
      });
      if (typeof selected === "string") return selected;
      return null;
    } catch (error) {
      console.error("Backup folder picker failed:", error);
      return null;
    }
  }
  const path = window.prompt("Backup folder path", defaultPath ?? "");
  return path?.trim() ? path.trim() : null;
}

export async function pickObsidianVaultFolder(
  defaultPath?: string
): Promise<string | null> {
  return pickBackupFolder(defaultPath);
}

export async function pickJoplinExportFolder(
  defaultPath?: string
): Promise<string | null> {
  return pickBackupFolder(defaultPath);
}

/** Suggested managed notebook name stem from a source file or folder. */
export function suggestedNotebookStem(sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  const basename = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  return basename.replace(/\.(sqlite3|sqlite|db|json)$/i, "") || "treenote";
}

/** Default Save-dialog path for a new notebook imported from a Markdown folder. */
export function defaultMarkdownFolderImportPath(folderPath: string): string {
  const normalized = folderPath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  const dir = lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : "";
  const basename = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const stem = basename || "treenote";
  return `${dir}${stem}.sqlite3`;
}

/** Default Save-dialog path for a new notebook imported from TreeNote JSON. */
export function defaultTreenoteJsonImportPath(jsonPath: string): string {
  const normalized = jsonPath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  const dir = lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : "";
  const basename = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const stem = basename.replace(/\.json$/i, "") || "treenote";
  return `${dir}${stem}.sqlite3`;
}

/** Default Save-dialog path for exporting the open notebook to TreeNote JSON. */
export function defaultTreenoteJsonExportPath(notebookPath: string): string {
  return defaultNotebookJsonExportPath(notebookPath);
}

/** Default Save-dialog path for whole-notebook JSON export. */
export function defaultNotebookJsonExportPath(notebookPath: string): string {
  const normalized = notebookPath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  const dir = lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : "";
  const basename = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const stem = basename.replace(/\.(sqlite3|sqlite|db)$/i, "") || "treenote";
  return `${dir}${stem}.json`;
}

/** Default Save-dialog path for a new notebook imported from Flashnote. */
export function defaultFlashnoteImportPath(flashnotePath: string): string {
  const normalized = flashnotePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  const dir = lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : "";
  const basename = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const stem = basename.replace(/\.(sqlite3|sqlite|db)$/i, "") || "flashnote";
  return `${dir}${stem}.sqlite3`;
}

/** Default Save-dialog path for exporting the open notebook to Flashnote. */
export function defaultFlashnoteExportPath(notebookPath: string): string {
  const normalized = notebookPath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  const dir = lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : "";
  const basename = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const stem = basename.replace(/\.(sqlite3|sqlite|db)$/i, "") || "treenote";
  return `${dir}${stem}-flashnote.db`;
}

export {
  backupDisplayLabel,
  formatBackupLabel,
  groupBackupListItems,
  filterBackupGroups,
  type BackupListGroup,
  type BackupListGroupId,
  type ManagedBackupEntry,
  type ManagedBackupList,
} from "./backupList";

export async function confirmRestore(message: string): Promise<boolean> {
  if (isTauriRuntime()) {
    try {
      return await showConfirm(message, {
        title: "Restore from backup",
        kind: "warning",
        okLabel: "Restore",
        cancelLabel: "Cancel",
      });
    } catch (error) {
      console.error("Restore confirm dialog failed:", error);
      return false;
    }
  }
  return window.confirm(message);
}

export async function confirmOpenNotebook(message: string): Promise<boolean> {
  if (isTauriRuntime()) {
    try {
      return await showConfirm(message, {
        title: "Open notebook",
        kind: "info",
        okLabel: "Open",
        cancelLabel: "Not now",
      });
    } catch (error) {
      console.error("Open notebook confirm dialog failed:", error);
      return false;
    }
  }
  return window.confirm(message);
}
