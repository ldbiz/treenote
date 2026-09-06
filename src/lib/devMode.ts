import { invoke } from "@tauri-apps/api/core";

let cachedDevMode: boolean | null = null;

export async function isDevMode(): Promise<boolean> {
  if (cachedDevMode === null) {
    cachedDevMode = await invoke<boolean>("is_dev_mode");
  }
  return cachedDevMode;
}

function isDevToolsShortcut(event: KeyboardEvent): boolean {
  if (event.key === "F12") return true;

  if (!event.ctrlKey || !event.shiftKey) return false;

  const key = event.key.toUpperCase();
  return key === "I" || key === "J" || key === "C" || key === "K";
}

export async function applyProductionWebviewGuards(): Promise<void> {
  if (await isDevMode()) return;

  window.addEventListener(
    "keydown",
    (event) => {
      if (isDevToolsShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true
  );

  document.addEventListener(
    "contextmenu",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        event.preventDefault();
        return;
      }

      if (target.closest("[data-app-context-menu], [data-app-editor-menu]")) {
        // Block the native menu early; app handlers still open our custom menus.
        event.preventDefault();
        return;
      }

      event.preventDefault();
    },
    true
  );
}
