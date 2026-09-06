import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function readClipboardText(): Promise<string | null> {
  if (isTauriRuntime()) {
    try {
      return await readText();
    } catch {
      return null;
    }
  }

  if (navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  }

  return null;
}

export async function writeClipboardText(text: string): Promise<boolean> {
  if (isTauriRuntime()) {
    try {
      await writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}
