import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "treenote-ui-zoom";
const TAURI_EVENT = "ui-zoom-changed";

const DEFAULT_ZOOM = 1;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 10) / 10));
}

function readStoredZoom(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = Number.parseFloat(stored);
      if (Number.isFinite(parsed)) {
        return clampZoom(parsed);
      }
    }
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_ZOOM;
}

export function applyUiZoom(zoom: number): void {
  document.documentElement.style.setProperty("--ui-zoom", String(zoom));
}

export function applyInitialUiZoom(): void {
  applyUiZoom(readStoredZoom());
}

async function broadcastUiZoom(zoom: number): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(TAURI_EVENT, { zoom });
  } catch {
    // Browser preview or Tauri API unavailable
  }
}

function isZoomInKey(key: string): boolean {
  return key === "=" || key === "+" || key === "Add";
}

function isZoomOutKey(key: string): boolean {
  return key === "-" || key === "_" || key === "Subtract";
}

export function useUiZoom() {
  const [zoom, setZoomState] = useState(readStoredZoom);

  useEffect(() => {
    applyUiZoom(zoom);
  }, [zoom]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      const parsed = Number.parseFloat(event.newValue);
      if (Number.isFinite(parsed)) {
        setZoomState(clampZoom(parsed));
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
        unlisten = await listen<{ zoom: number }>(TAURI_EVENT, (event) => {
          if (Number.isFinite(event.payload.zoom)) {
            setZoomState(clampZoom(event.payload.zoom));
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

  const setZoom = useCallback((next: number | ((current: number) => number)) => {
    setZoomState((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      const clamped = clampZoom(resolved);
      try {
        localStorage.setItem(STORAGE_KEY, String(clamped));
      } catch {
        // ignore storage errors
      }
      void broadcastUiZoom(clamped);
      return clamped;
    });
  }, []);

  const zoomIn = useCallback(() => {
    setZoom((current) => current + ZOOM_STEP);
  }, [setZoom]);

  const zoomOut = useCallback(() => {
    setZoom((current) => current - ZOOM_STEP);
  }, [setZoom]);

  const resetZoom = useCallback(() => {
    setZoom(DEFAULT_ZOOM);
  }, [setZoom]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

      if (isZoomInKey(event.key)) {
        event.preventDefault();
        zoomIn();
      } else if (isZoomOutKey(event.key)) {
        event.preventDefault();
        zoomOut();
      } else if (event.key === "0") {
        event.preventDefault();
        resetZoom();
      }
    };

    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      if (event.deltaY < 0) {
        zoomIn();
      } else if (event.deltaY > 0) {
        zoomOut();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("wheel", onWheel);
    };
  }, [resetZoom, zoomIn, zoomOut]);

  return { zoom, setZoom, zoomIn, zoomOut, resetZoom };
}
