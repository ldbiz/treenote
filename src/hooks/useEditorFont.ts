import { useCallback, useEffect, useState } from "react";
import {
  applyEditorFontFamily,
  type EditorFontId,
  isEditorFontId,
} from "../lib/editorFonts";

export type { EditorFontId as EditorFontFamily } from "../lib/editorFonts";

const STORAGE_KEY = "treenote-editor-font-family";
const TAURI_EVENT = "editor-font-changed";

function readStoredFont(): EditorFontId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isEditorFontId(stored)) {
      return stored;
    }
  } catch {
    // localStorage unavailable
  }
  return "system";
}

export function applyEditorFont(family: EditorFontId): void {
  applyEditorFontFamily(family);
}

export function applyInitialEditorFont(): void {
  applyEditorFont(readStoredFont());
}

async function broadcastEditorFont(family: EditorFontId): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(TAURI_EVENT, { family });
  } catch {
    // Browser preview or Tauri API unavailable
  }
}

export function useEditorFont() {
  const [family, setFamily] = useState<EditorFontId>(readStoredFont);

  useEffect(() => {
    applyEditorFont(family);
  }, [family]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      if (isEditorFontId(event.newValue)) {
        setFamily(event.newValue);
      }
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<{ family: EditorFontId }>(TAURI_EVENT, (event) => {
          if (isEditorFontId(event.payload.family)) {
            setFamily(event.payload.family);
          }
        });
      } catch {
        // Browser preview or Tauri API unavailable
      }
    })();

    return () => {
      unlisten?.();
    };
  }, []);

  const setEditorFontFamily = useCallback((next: EditorFontId) => {
    setFamily(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
    void broadcastEditorFont(next);
  }, []);

  return { editorFontFamily: family, setEditorFontFamily };
}
