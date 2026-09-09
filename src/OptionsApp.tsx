import { type ReactNode, useEffect, useState } from "react";
import { FluentProvider, ProgressBar, webDarkTheme, webLightTheme } from "@fluentui/react-components";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AutoTheme, Moon, Sun } from "./components/icons";
import { useTheme, type ThemePreference } from "./hooks/useTheme";
import { useEditorFont, type EditorFontFamily } from "./hooks/useEditorFont";
import {
  EDITOR_FONT_CATEGORIES,
  EDITOR_FONT_OPTIONS,
  getEditorFontStack,
  isEditorFontId,
} from "./lib/editorFonts";
import { useUiZoom } from "./hooks/useUiZoom";
import RestoreBackupDialog from "./components/RestoreBackupDialog";
import CreateBackupDialog from "./components/CreateBackupDialog";
import NotebookNameDialog from "./components/NotebookNameDialog";
import { confirmRestore, confirmOpenNotebook, defaultFlashnoteExportPath, defaultTreenoteJsonExportPath, pickFlashnoteDatabase, pickFlashnoteSavePath, pickJoplinExportFolder, pickJsonExportPath, pickObsidianVaultFolder, pickTreenoteJsonFile, suggestedNotebookStem } from "./lib/dialogs";
import {
  backupDisplayLabel,
  formatBackupLabel,
  type ManagedBackupEntry,
  type ManagedBackupList,
} from "./lib/backupList";
import {
  createFlushRequestId,
  waitForFlushResult,
  writeFlushRequest,
} from "./lib/editorFlushBridge";
import { joinExportPath } from "./lib/exportPath";
import "./styles/theme.css";

const THEME_OPTIONS: {
  value: ThemePreference;
  label: string;
  Icon: typeof Sun;
}[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: AutoTheme },
];

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

type AppSettings = {
  database_path: string;
  export_folder: string;
  editor_font_family: string;
  minimize_to_tray: boolean;
  backup_before_restore: boolean;
};

type MessageKind = "success" | "error" | "info";
type SectionId = "general" | "appearance" | "notebook" | "conversion" | "backups" | "security";
type SectionMessage = { kind: MessageKind; text: string };

function notebookFileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

type ManagedBackupEntryLocal = ManagedBackupEntry;

type RunBackupNowResult = {
  path: string;
  metadata_saved: boolean;
  metadata_warning?: string | null;
};

type BackupProgressState = {
  requestId: string;
  phase: "snapshot" | "restore" | "finished";
  done: number;
  total: number;
  caption: string;
} | null;

type ImportSummary = {
  notes_imported: number;
  notes_skipped: number;
  dest_path: string;
};

type ExportSummary = {
  notes_exported: number;
  dest_path: string;
};

type JsonImportSummary = {
  notes_imported: number;
  dest_path: string;
};

type NotebookCounts = {
  notes: number;
  trees: number;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function SectionStatus({
  kind,
  children,
}: {
  kind: MessageKind;
  children: ReactNode;
}) {
  return (
    <p
      className={`options-section-status options-status options-status-${kind}`}
      role={kind === "error" ? "alert" : "status"}
    >
      {children}
    </p>
  );
}

function OptionsSection({
  title,
  description,
  children,
  status,
}: {
  title: string;
  description: string;
  children: ReactNode;
  status?: SectionMessage;
}) {
  return (
    <section className="options-section">
      <h2 className="options-section-title">{title}</h2>
      <p className="options-section-desc">{description}</p>
      {children}
      {status?.text ? <SectionStatus kind={status.kind}>{status.text}</SectionStatus> : null}
    </section>
  );
}

function OptionsApp() {
  const { preference, resolvedTheme, setThemePreference } = useTheme();
  const { editorFontFamily, setEditorFontFamily } = useEditorFont();
  const { zoom, setZoom, resetZoom } = useUiZoom();

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [notebooks, setNotebooks] = useState<string[]>([]);
  const [nameDialog, setNameDialog] = useState<{
    title: string;
    initialName: string;
    confirmLabel: string;
    onConfirm: (name: string) => void;
  } | null>(null);
  const [sectionMessages, setSectionMessages] = useState<Partial<Record<SectionId, SectionMessage>>>({});
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [hasPassword, setHasPassword] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [managedBackups, setManagedBackups] = useState<ManagedBackupEntryLocal[]>([]);
  const [metadataWarning, setMetadataWarning] = useState<string | null>(null);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [createBackupDialogOpen, setCreateBackupDialogOpen] = useState(false);
  const [dialogSelectedTimestamp, setDialogSelectedTimestamp] = useState<number | null>(null);
  const [backupProgress, setBackupProgress] = useState<BackupProgressState>(null);
  const [notebookCounts, setNotebookCounts] = useState<NotebookCounts | null>(null);

  const isBusy = (action: string) => busyAction === action;
  const isAnyBusy = busyAction !== null;

  const showSectionMessage = (section: SectionId, kind: MessageKind, text: string) => {
    setSectionMessages((prev) => ({ ...prev, [section]: { kind, text } }));
  };

  const clearSectionMessage = (section: SectionId) => {
    setSectionMessages((prev) => {
      const next = { ...prev };
      delete next[section];
      return next;
    });
  };

  const runAction = async (action: string, fn: () => Promise<void>) => {
    setBusyAction(action);
    try {
      await fn();
    } finally {
      setBusyAction(null);
    }
  };

  const loadBackups = async (): Promise<ManagedBackupEntryLocal[]> => {
    const list = await invoke<ManagedBackupList>("list_managed_backups");
    setManagedBackups(list.entries);
    setMetadataWarning(list.metadata_warning ?? null);
    if (list.metadata_warning) {
      showSectionMessage("backups", "error", list.metadata_warning);
    }
    return list.entries;
  };

  const loadNotebookCounts = async (): Promise<NotebookCounts> => {
    const counts = await invoke<NotebookCounts>("notebook_counts");
    setNotebookCounts(counts);
    return counts;
  };

  const closeRestoreDialog = () => {
    setRestoreDialogOpen(false);
    setDialogSelectedTimestamp(null);
  };

  const load = async () => {
    const [s, sec, names] = await Promise.all([
      invoke<AppSettings>("get_settings"),
      invoke<{ password_configured: boolean }>("security_status"),
      invoke<string[]>("list_notebooks"),
    ]);
    setSettings(s);
    setNotebooks(names);
    setHasPassword(sec.password_configured);
    const family = s.editor_font_family || "system";
    if (isEditorFontId(family)) {
      setEditorFontFamily(family);
    }
    await Promise.all([loadBackups(), loadNotebookCounts()]);
    setLoading(false);
  };

  useEffect(() => {
    void load().catch((error) =>
      showSectionMessage("notebook", "error", `Failed to load settings: ${errorText(error)}`),
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listen<{
      request_id: string;
      phase: string;
      done: number;
      total: number;
    }>("backup-progress", (event) => {
      if (cancelled) return;
      const { request_id, phase, done, total } = event.payload;
      if (phase === "finished") {
        setBackupProgress(null);
        return;
      }
      const caption =
        phase === "snapshot"
          ? "Saving backup snapshot…"
          : "Restoring notebook…";
      setBackupProgress({
        requestId: request_id,
        phase: phase as "snapshot" | "restore",
        done,
        total,
        caption,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "treenote-db-switch-result" && event.newValue) {
        try {
          const result = JSON.parse(event.newValue) as { ok?: boolean; name?: string; path?: string; error?: string };
          if (result.ok) {
            showSectionMessage("notebook", "success", `Notebook switched to ${result.name || result.path}.`);
            void load().catch((error) =>
              showSectionMessage(
                "notebook",
                "error",
                `Notebook switched, but settings reload failed: ${errorText(error)}`,
              ),
            );
          } else {
            showSectionMessage(
              "notebook",
              "error",
              `Notebook switch failed: ${result.error || "Unknown error"}`,
            );
          }
        } catch {
          showSectionMessage("notebook", "error", "Notebook switch failed: invalid response from main window.");
        }
        return;
      }
      if (event.key === "treenote-backup-restore-result" && event.newValue) {
        try {
          const result = JSON.parse(event.newValue) as {
            ok?: boolean;
            timestamp?: number;
            error?: string;
            createBackupFirst?: boolean;
          };
          if (result.ok) {
            const label =
              typeof result.timestamp === "number"
                ? formatBackupLabel(result.timestamp)
                : "the selected backup";
            const safetyNote = result.createBackupFirst === false
              ? ""
              : " Your previous version was saved as a backup.";
            showSectionMessage(
              "backups",
              "success",
              `Notebook restored to ${label}.${safetyNote}`,
            );
            void load().catch((error) =>
              showSectionMessage(
                "backups",
                "error",
                `Notebook restored, but settings reload failed: ${errorText(error)}`,
              ),
            );
            closeRestoreDialog();
          } else {
            showSectionMessage(
              "backups",
              "error",
              `Restore failed: ${result.error || "Unknown error"}`,
            );
          }
        } catch {
          showSectionMessage("backups", "error", "Restore failed: invalid response from main window.");
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const requestNotebookSwitch = (name: string) => {
    localStorage.setItem("treenote-db-switch-request", JSON.stringify({ name, at: Date.now() }));
    showSectionMessage(
      "notebook",
      "info",
      "Notebook switch requested. The main window will save the current note before switching.",
    );
  };

  const requestImportedNotebookSwitch = (destPath: string) => {
    requestNotebookSwitch(notebookFileName(destPath));
  };

  const switchNotebook = async (name: string) => {
    if (!name || name === notebookFileName(settings?.database_path || "")) return;
    clearSectionMessage("notebook");
    await runAction("switchDb", async () => {
      try {
        requestNotebookSwitch(name);
      } catch (error) {
        showSectionMessage("notebook", "error", `Failed to request notebook switch: ${errorText(error)}`);
      }
    });
  };

  const createManagedNotebook = () => {
    clearSectionMessage("notebook");
    setNameDialog({
      title: "Create notebook",
      initialName: "",
      confirmLabel: "Create",
      onConfirm: (name) => {
        setNameDialog(null);
        void runAction("createNotebook", async () => {
          try {
            const created = await invoke<string>("create_notebook", { name });
            setNotebooks((current) =>
              current.includes(created) ? current : [...current, created].sort(),
            );
            requestNotebookSwitch(created);
          } catch (error) {
            showSectionMessage("notebook", "error", `Failed to create notebook: ${errorText(error)}`);
          }
        });
      },
    });
  };

  const importWithName = async (
    action: string,
    suggested: string,
    runImport: (notebookName: string) => Promise<{ dest_path: string; notes_imported: number; notes_skipped?: number }>,
    errorLabel: string,
  ) => {
    setNameDialog({
      title: "Import notebook",
      initialName: suggested,
      confirmLabel: "Import",
      onConfirm: (name) => {
        setNameDialog(null);
        void runAction(action, async () => {
          try {
            const summary = await runImport(name);
            const skipped =
              summary.notes_skipped && summary.notes_skipped > 0
                ? ` (${summary.notes_skipped} skipped)`
                : "";
            showSectionMessage(
              "conversion",
              "success",
              `Imported ${summary.notes_imported} notes into ${notebookFileName(summary.dest_path)}${skipped}.`,
            );
            const openNow = await confirmOpenNotebook(
              `Open ${notebookFileName(summary.dest_path)} now?\n\nTreeNote will save your current note before switching.`,
            );
            if (!openNow) {
              await load().catch(() => undefined);
              return;
            }
            requestImportedNotebookSwitch(summary.dest_path);
          } catch (error) {
            showSectionMessage("conversion", "error", `${errorLabel}: ${errorText(error)}`);
          }
        });
      },
    });
  };

  const persistFontFamily = async (family: EditorFontFamily) => {
    if (!settings) return;
    clearSectionMessage("appearance");
    try {
      const saved = await invoke<AppSettings>("update_settings", {
        editorFontFamily: family,
        minimizeToTray: settings.minimize_to_tray,
        backupBeforeRestore: settings.backup_before_restore,
      });
      setSettings(saved);
    } catch (error) {
      showSectionMessage("appearance", "error", `Failed to save font: ${errorText(error)}`);
    }
  };

  const persistMinimizeToTray = async (enabled: boolean) => {
    if (!settings) return;
    clearSectionMessage("general");
    try {
      const saved = await invoke<AppSettings>("update_settings", {
        editorFontFamily: settings.editor_font_family,
        minimizeToTray: enabled,
        backupBeforeRestore: settings.backup_before_restore,
      });
      setSettings(saved);
    } catch (error) {
      showSectionMessage("general", "error", `Failed to save setting: ${errorText(error)}`);
    }
  };

  const importFlashnote = async () => {
    clearSectionMessage("conversion");
    const sourcePath = await pickFlashnoteDatabase();
    if (!sourcePath) return;
    await importWithName(
      "importFlashnote",
      suggestedNotebookStem(sourcePath),
      (notebookName) =>
        invoke<ImportSummary>("import_flashnote", { sourcePath, notebookName }),
      "Flashnote import failed",
    );
  };

  const exportFlashnote = async () => {
    clearSectionMessage("conversion");
    const defaultPath = joinExportPath(
      settings?.export_folder || "",
      defaultFlashnoteExportPath(settings?.database_path || "treenote").split(/[\\/]/).pop() || "treenote-flashnote.db",
    );
    const destPath = await pickFlashnoteSavePath(defaultPath);
    if (!destPath) return;

    await runAction("exportFlashnote", async () => {
      try {
        const requestId = createFlushRequestId();
        writeFlushRequest(requestId);
        await waitForFlushResult(requestId);
        const summary = await invoke<ExportSummary>("export_flashnote", { destPath });
        showSectionMessage(
          "conversion",
          "success",
          `Exported ${summary.notes_exported} notes to ${summary.dest_path}.`,
        );
      } catch (error) {
        showSectionMessage(
          "conversion",
          "error",
          error instanceof Error && error.message === "Couldn't save the current note."
            ? "Couldn't save the current note."
            : `Flashnote export failed: ${errorText(error)}`,
        );
      }
    });
  };

  const exportTreenoteJson = async () => {
    clearSectionMessage("conversion");
    const defaultPath = joinExportPath(
      settings?.export_folder || "",
      defaultTreenoteJsonExportPath(settings?.database_path || "treenote").split(/[\\/]/).pop() || "treenote.json",
    );
    const destPath = await pickJsonExportPath(defaultPath);
    if (!destPath) return;

    await runAction("exportTreenoteJson", async () => {
      try {
        const requestId = createFlushRequestId();
        writeFlushRequest(requestId);
        await waitForFlushResult(requestId);
        const summary = await invoke<ExportSummary>("export_treenote_json", { destPath });
        showSectionMessage(
          "conversion",
          "success",
          `Exported ${summary.notes_exported} notes to ${summary.dest_path}.`,
        );
      } catch (error) {
        showSectionMessage(
          "conversion",
          "error",
          error instanceof Error && error.message === "Couldn't save the current note."
            ? "Couldn't save the current note."
            : `TreeNote JSON export failed: ${errorText(error)}`,
        );
      }
    });
  };

  const importObsidian = async () => {
    clearSectionMessage("conversion");
    const sourcePath = await pickObsidianVaultFolder();
    if (!sourcePath) return;
    await importWithName(
      "importObsidian",
      suggestedNotebookStem(sourcePath),
      (notebookName) =>
        invoke<JsonImportSummary>("import_obsidian", { sourcePath, notebookName }),
      "Obsidian import failed",
    );
  };

  const importJoplin = async () => {
    clearSectionMessage("conversion");
    const sourcePath = await pickJoplinExportFolder();
    if (!sourcePath) return;
    await importWithName(
      "importJoplin",
      suggestedNotebookStem(sourcePath),
      (notebookName) => invoke<JsonImportSummary>("import_joplin", { sourcePath, notebookName }),
      "Joplin import failed",
    );
  };

  const importTreenoteJson = async () => {
    clearSectionMessage("conversion");
    const sourcePath = await pickTreenoteJsonFile();
    if (!sourcePath) return;
    await importWithName(
      "importTreenoteJson",
      suggestedNotebookStem(sourcePath),
      (notebookName) =>
        invoke<JsonImportSummary>("import_treenote_json", { sourcePath, notebookName }),
      "TreeNote JSON import failed",
    );
  };

  const persistBackupBeforeRestore = async (enabled: boolean) => {
    if (!settings) return;
    clearSectionMessage("backups");
    try {
      const saved = await invoke<AppSettings>("update_settings", {
        editorFontFamily: settings.editor_font_family,
        minimizeToTray: settings.minimize_to_tray,
        backupBeforeRestore: enabled,
      });
      setSettings(saved);
    } catch (error) {
      showSectionMessage("backups", "error", `Failed to save setting: ${errorText(error)}`);
    }
  };

  const backupNow = () => {
    if (!settings) return;
    clearSectionMessage("backups");
    setCreateBackupDialogOpen(true);
  };

  const confirmCreateBackup = async (label: string, locked: boolean) => {
    if (!settings) return;
    await runAction("backupNow", async () => {
      try {
        const requestId = createFlushRequestId();
        writeFlushRequest(requestId);
        await waitForFlushResult(requestId);
        const progressId = createFlushRequestId();
        const trimmed = label.trim();
        const result = await invoke<RunBackupNowResult>("run_backup_now", {
          label: trimmed.length > 0 ? trimmed : null,
          locked,
          progressId,
        });
        setCreateBackupDialogOpen(false);
        let message = `Backup created: ${result.path}.`;
        if (result.metadata_warning) {
          message += ` ${result.metadata_warning}`;
        }
        showSectionMessage("backups", result.metadata_saved ? "success" : "info", message);
        await loadBackups();
      } catch (error) {
        showSectionMessage(
          "backups",
          "error",
          error instanceof Error && error.message === "Couldn't save the current note."
            ? "Couldn't save the current note."
            : `Backup failed: ${errorText(error)}`,
        );
      } finally {
        setBackupProgress(null);
      }
    });
  };

  const openRestoreDialog = async () => {
    clearSectionMessage("backups");
    try {
      const backups = await loadBackups();
      if (backups.length === 0) {
        showSectionMessage("backups", "info", "No backups are available for this notebook yet.");
        return;
      }
      setDialogSelectedTimestamp(null);
      setRestoreDialogOpen(true);
    } catch (error) {
      showSectionMessage("backups", "error", `Failed to load backups: ${errorText(error)}`);
    }
  };

  const confirmRestoreSelection = async () => {
    if (!settings || dialogSelectedTimestamp === null) return;
    clearSectionMessage("backups");
    const label = backupDisplayLabel(
      managedBackups.find((entry) => entry.timestamp === dialogSelectedTimestamp) ?? {
        timestamp: dialogSelectedTimestamp,
        label: null,
        locked: false,
      },
    );
    const backupNote = settings.backup_before_restore
      ? "\n\nTreeNote will first save a backup of the current version."
      : "\n\nThe current notebook will be replaced without creating a backup first.";
    const confirmed = await confirmRestore(`Restore this notebook to ${label}?${backupNote}`);
    if (!confirmed) return;
    await runAction("restoreBackup", async () => {
      try {
        const progressId = createFlushRequestId();
        localStorage.setItem(
          "treenote-backup-restore-request",
          JSON.stringify({
            timestamp: dialogSelectedTimestamp,
            createBackupFirst: settings.backup_before_restore,
            progressId,
            at: Date.now(),
          }),
        );
        closeRestoreDialog();
        showSectionMessage(
          "backups",
          "info",
          "Restore requested. The main window will save your current note before restoring.",
        );
      } catch (error) {
        showSectionMessage("backups", "error", `Failed to request restore: ${errorText(error)}`);
      }
    });
  };

  const handleKeepSelectedChange = async (locked: boolean) => {
    if (dialogSelectedTimestamp === null) return;
    try {
      const list = await invoke<ManagedBackupList>("set_backup_lock", {
        timestamp: dialogSelectedTimestamp,
        locked,
      });
      setManagedBackups(list.entries);
      setMetadataWarning(list.metadata_warning ?? null);
    } catch (error) {
      showSectionMessage("backups", "error", `Failed to update backup lock: ${errorText(error)}`);
    }
  };

  const savePassword = async () => {
    clearSectionMessage("security");
    if (!newPassword.trim()) {
      showSectionMessage("security", "error", "Enter a password.");
      return;
    }
    if (hasPassword && !currentPassword) {
      showSectionMessage("security", "error", "Enter your current password.");
      return;
    }
    await runAction("savePassword", async () => {
      try {
        await invoke("set_password", {
          currentPassword: hasPassword ? currentPassword : null,
          newPassword,
        });
        setCurrentPassword("");
        setNewPassword("");
        setHasPassword(true);
        showSectionMessage(
          "security",
          "success",
          "Password updated. This is an app lock only; your notebook file is not encrypted.",
        );
      } catch (error) {
        showSectionMessage("security", "error", `Password update failed: ${errorText(error)}`);
      }
    });
  };

  const removePassword = async () => {
    clearSectionMessage("security");
    if (!currentPassword) {
      showSectionMessage("security", "error", "Enter your current password to remove the lock.");
      return;
    }
    await runAction("removePassword", async () => {
      try {
        await invoke("remove_password", { currentPassword });
        setCurrentPassword("");
        setNewPassword("");
        setHasPassword(false);
        showSectionMessage("security", "success", "Password removed.");
      } catch (error) {
        showSectionMessage("security", "error", `Password removal failed: ${errorText(error)}`);
      }
    });
  };

  const zoomPercent = Math.round(zoom * 100);
  const selectedFontStack = getEditorFontStack(editorFontFamily);

  return (
    <FluentProvider theme={resolvedTheme === "dark" ? webDarkTheme : webLightTheme}>
      <div className="options-root">
        <header className="options-header">
          <h1 className="options-title">Settings</h1>
          <p className="options-subtitle">
            Customize appearance, notebooks, backups, security, and conversion.
          </p>
          {!loading && notebookCounts ? (
            <p className="options-notebook-tally" aria-live="polite">
              {notebookCounts.notes} {notebookCounts.notes === 1 ? "note" : "notes"} ·{" "}
              {notebookCounts.trees} {notebookCounts.trees === 1 ? "tree" : "trees"}
            </p>
          ) : null}
        </header>

        <OptionsSection
          title="General"
          description="Control how TreeNote behaves on this device."
          status={sectionMessages.general}
        >
          <label className="options-field options-checkbox-field">
            <input
              type="checkbox"
              className="options-checkbox"
              checked={settings?.minimize_to_tray ?? true}
              disabled={isAnyBusy || !settings}
              onChange={(e) => {
                const enabled = e.target.checked;
                setSettings((s) => s && { ...s, minimize_to_tray: enabled });
                void persistMinimizeToTray(enabled);
              }}
            />
            <span className="options-checkbox-label">Minimize to system tray</span>
          </label>
          <p className="options-field-hint">
            When enabled, closing or minimizing TreeNote hides it to the tray. When disabled, it
            behaves like a normal app in the taskbar.
          </p>
        </OptionsSection>

        <OptionsSection
          title="Appearance"
          description="Choose how Tree Note looks on this device."
          status={sectionMessages.appearance}
        >
          <div className="options-field">
            <span className="options-field-label" id="theme-label">
              Theme
            </span>
            <div className="options-segmented" role="radiogroup" aria-labelledby="theme-label">
              {THEME_OPTIONS.map(({ value, label, Icon }) => {
                const selected = preference === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`options-segment${selected ? " options-segment-active" : ""}`}
                    onClick={() => setThemePreference(value)}
                  >
                    <Icon width={16} height={16} aria-hidden />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="options-field">
            <label className="options-field-label" htmlFor="editor-font-select">
              Editor font
            </label>
            <select
              id="editor-font-select"
              className="options-control options-font-select"
              value={editorFontFamily}
              disabled={isAnyBusy}
              style={selectedFontStack ? { fontFamily: selectedFontStack } : undefined}
              onChange={(e) => {
                const family = e.target.value;
                if (!isEditorFontId(family)) return;
                setEditorFontFamily(family);
                setSettings((s) => s && { ...s, editor_font_family: family });
                void persistFontFamily(family);
              }}
            >
              {EDITOR_FONT_CATEGORIES.map((category) => (
                <optgroup key={category.id} label={category.label}>
                  {EDITOR_FONT_OPTIONS
                    .filter((option) => option.category === category.id)
                    .map(({ id, label, stack }) => (
                      <option key={id} value={id} style={stack ? { fontFamily: stack } : undefined}>
                        {label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
            <p
              className="options-font-preview"
              aria-hidden="true"
              style={selectedFontStack ? { fontFamily: selectedFontStack } : undefined}
            >
              The quick brown fox jumps over the lazy dog.
            </p>
            <p className="options-field-hint">Uses fonts installed on your system.</p>
          </div>

          <div className="options-field">
            <div className="options-field-header">
              <span className="options-field-label" id="zoom-label">
                Interface zoom
              </span>
              <span className="options-zoom-value" aria-live="polite">
                {zoomPercent}%
              </span>
            </div>
            <div className="options-zoom-row">
              <input
                className="options-zoom-slider"
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={ZOOM_STEP}
                value={zoom}
                aria-labelledby="zoom-label"
                aria-valuemin={MIN_ZOOM * 100}
                aria-valuemax={MAX_ZOOM * 100}
                aria-valuenow={zoomPercent}
                onChange={(e) => setZoom(Number.parseFloat(e.target.value))}
              />
              <button
                type="button"
                className="options-btn options-btn-secondary options-btn-compact"
                onClick={resetZoom}
                disabled={zoom === 1}
              >
                Reset
              </button>
            </div>
            <p className="options-field-hint">Also adjustable with Ctrl + mouse wheel or Ctrl + 0 to reset.</p>
          </div>
        </OptionsSection>

        <OptionsSection
          title="Notebook"
          description="Switch between TreeNote notebooks in your data folder."
          status={sectionMessages.notebook}
        >
          <label className="options-field">
            <span className="options-field-label">Notebook</span>
            <select
              className="options-control"
              value={notebookFileName(settings?.database_path || "")}
              disabled={isAnyBusy || loading || notebooks.length === 0}
              onChange={(e) => void switchNotebook(e.target.value)}
            >
              {notebooks.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <div className="options-actions">
            <button
              type="button"
              className="options-btn options-btn-secondary"
              onClick={createManagedNotebook}
              disabled={isAnyBusy || loading}
            >
              {isBusy("createNotebook") ? "Creating…" : "Create notebook…"}
            </button>
          </div>
        </OptionsSection>

        <OptionsSection
          title="Backups"
          description="TreeNote automatically keeps 10-minute, hourly, daily, weekly, monthly and yearly recovery points."
          status={sectionMessages.backups}
        >
          <p className="options-field-hint">
            Backups are stored in the TreeNote data folder.
          </p>

          {managedBackups.length === 0 && !loading ? (
            <p className="options-field-hint">No backups are available for this notebook yet.</p>
          ) : null}

          <div className="options-actions">
            <button
              type="button"
              className="options-btn options-btn-secondary"
              onClick={backupNow}
              disabled={isAnyBusy || loading}
            >
              {isBusy("backupNow") ? "Running…" : "Back up now"}
            </button>
            <button
              type="button"
              className="options-btn options-btn-secondary"
              onClick={() => void openRestoreDialog()}
              disabled={isAnyBusy || loading || managedBackups.length === 0}
            >
              {isBusy("restoreBackup") ? "Restoring…" : "Restore from backup…"}
            </button>
          </div>

          {backupProgress ? (
            <div className="backup-progress-block" role="status" aria-live="polite">
              <p className="backup-progress-caption">{backupProgress.caption}</p>
              <ProgressBar
                value={
                  backupProgress.phase === "snapshot" && backupProgress.total > 0
                    ? backupProgress.done / backupProgress.total
                    : undefined
                }
                thickness="medium"
              />
            </div>
          ) : null}

          {metadataWarning && !sectionMessages.backups?.text ? (
            <SectionStatus kind="error">{metadataWarning}</SectionStatus>
          ) : null}
        </OptionsSection>

        <CreateBackupDialog
          open={createBackupDialogOpen}
          busy={isBusy("backupNow")}
          onConfirm={(label, locked) => void confirmCreateBackup(label, locked)}
          onCancel={() => setCreateBackupDialogOpen(false)}
        />

        <RestoreBackupDialog
          open={restoreDialogOpen}
          backups={managedBackups}
          selectedTimestamp={dialogSelectedTimestamp}
          backupBeforeRestore={settings?.backup_before_restore ?? true}
          busy={isBusy("restoreBackup")}
          onSelect={setDialogSelectedTimestamp}
          onClearSelection={() => setDialogSelectedTimestamp(null)}
          onBackupBeforeRestoreChange={(enabled) => {
            setSettings((current) =>
              current ? { ...current, backup_before_restore: enabled } : current,
            );
            void persistBackupBeforeRestore(enabled);
          }}
          onKeepSelectedChange={(locked) => void handleKeepSelectedChange(locked)}
          onRestore={() => void confirmRestoreSelection()}
          onCancel={closeRestoreDialog}
        />
        <NotebookNameDialog
          open={nameDialog !== null}
          title={nameDialog?.title || "Notebook"}
          initialName={nameDialog?.initialName ?? ""}
          confirmLabel={nameDialog?.confirmLabel || "Create"}
          busy={isBusy("createNotebook") || isBusy("importFlashnote") || isBusy("importObsidian") || isBusy("importJoplin") || isBusy("importTreenoteJson")}
          onConfirm={(name) => nameDialog?.onConfirm(name)}
          onCancel={() => setNameDialog(null)}
        />

        <OptionsSection
          title="Security"
          description="Protect Tree Note with an app lock on this device."
          status={sectionMessages.security}
        >
          <div className="options-notice" role="note">
            App-lock only. This does not encrypt your notebook file. Anyone with filesystem access to it
            may be able to read it.
          </div>
          {hasPassword && (
            <label className="options-field">
              <span className="options-field-label">Current password</span>
              <input
                className="options-control"
                type="password"
                autoComplete="current-password"
                placeholder="Current password"
                value={currentPassword}
                disabled={isAnyBusy}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </label>
          )}
          <label className="options-field">
            <span className="options-field-label">{hasPassword ? "New password" : "Password"}</span>
            <input
              className="options-control"
              type="password"
              autoComplete={hasPassword ? "new-password" : "new-password"}
              placeholder={hasPassword ? "New password" : "Choose a password"}
              value={newPassword}
              disabled={isAnyBusy}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </label>
          <div className="options-actions">
            <button
              type="button"
              className="options-btn options-btn-primary"
              onClick={savePassword}
              disabled={isAnyBusy || !newPassword.trim() || (hasPassword && !currentPassword)}
            >
              {isBusy("savePassword")
                ? "Saving…"
                : hasPassword
                  ? "Change password"
                  : "Set password"}
            </button>
            {hasPassword && (
              <button
                type="button"
                className="options-btn options-btn-danger"
                onClick={removePassword}
                disabled={isAnyBusy || !currentPassword}
              >
                {isBusy("removePassword") ? "Removing…" : "Remove password"}
              </button>
            )}
          </div>
        </OptionsSection>

        <OptionsSection
          title="Conversion"
          description="Import from or export to other formats."
          status={sectionMessages.conversion}
        >
          <div className="options-field">
            <span className="options-field-label">Obsidian</span>
            <p className="options-field-hint">Select an Obsidian vault folder.</p>
          </div>
          <div className="options-actions">
            <button
              type="button"
              className="options-btn options-btn-secondary"
              onClick={() => void importObsidian()}
              disabled={isAnyBusy || loading}
            >
              {isBusy("importObsidian") ? "Importing…" : "Import from Obsidian…"}
            </button>
          </div>

          <div className="options-field options-field-spaced">
            <span className="options-field-label">Joplin</span>
            <p className="options-field-hint">Select a Joplin Markdown export folder.</p>
          </div>
          <div className="options-actions">
            <button
              type="button"
              className="options-btn options-btn-secondary"
              onClick={() => void importJoplin()}
              disabled={isAnyBusy || loading}
            >
              {isBusy("importJoplin") ? "Importing…" : "Import from Joplin…"}
            </button>
          </div>

          <div className="options-field options-field-spaced">
            <span className="options-field-label">TreeNote JSON</span>
          </div>
          <div className="options-actions">
            <button
              type="button"
              className="options-btn options-btn-secondary"
              onClick={() => void importTreenoteJson()}
              disabled={isAnyBusy || loading}
            >
              {isBusy("importTreenoteJson") ? "Importing…" : "Import JSON…"}
            </button>
            <button
              type="button"
              className="options-btn options-btn-secondary"
              onClick={() => void exportTreenoteJson()}
              disabled={isAnyBusy || loading}
            >
              {isBusy("exportTreenoteJson") ? "Exporting…" : "Export JSON…"}
            </button>
          </div>

          <div className="options-field options-field-spaced">
            <span className="options-field-label">Flashnote</span>
          </div>
          <div className="options-actions">
            <button
              type="button"
              className="options-btn options-btn-secondary"
              onClick={() => void importFlashnote()}
              disabled={isAnyBusy || loading}
            >
              {isBusy("importFlashnote") ? "Importing…" : "Import from Flashnote…"}
            </button>
            <button
              type="button"
              className="options-btn options-btn-secondary"
              onClick={() => void exportFlashnote()}
              disabled={isAnyBusy || loading}
            >
              {isBusy("exportFlashnote") ? "Exporting…" : "Export to Flashnote…"}
            </button>
          </div>
        </OptionsSection>
      </div>
    </FluentProvider>
  );
}

export default OptionsApp;
