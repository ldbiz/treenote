/** Cross-window flush request/result bridge (main ↔ options). */

export const FLUSH_REQUEST_KEY = "treenote-flush-request";
export const FLUSH_RESULT_KEY = "treenote-flush-result";

export const FLUSH_TIMEOUT_MS = 30_000;

export type FlushRequest = {
  requestId: string;
  at: number;
};

export type FlushResult = {
  requestId: string;
  ok: boolean;
  error?: string;
  at: number;
};

export function createFlushRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export function writeFlushRequest(requestId: string): void {
  const payload: FlushRequest = { requestId, at: Date.now() };
  localStorage.setItem(FLUSH_REQUEST_KEY, JSON.stringify(payload));
}

/**
 * Wait for a flush result matching requestId. Rejects on timeout or failure.
 */
export function waitForFlushResult(requestId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("storage", onStorage);
      reject(new Error("Couldn't save the current note."));
    }, FLUSH_TIMEOUT_MS);

    const finish = (result: FlushResult) => {
      window.clearTimeout(timeout);
      window.removeEventListener("storage", onStorage);
      if (result.ok) {
        resolve();
      } else {
        reject(
          new Error(result.error || "Couldn't save the current note."),
        );
      }
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key !== FLUSH_RESULT_KEY || !event.newValue) return;
      try {
        const result = JSON.parse(event.newValue) as FlushResult;
        if (result.requestId !== requestId) return;
        finish(result);
      } catch {
        /* ignore malformed */
      }
    };

    window.addEventListener("storage", onStorage);

    try {
      const existing = localStorage.getItem(FLUSH_RESULT_KEY);
      if (existing) {
        const result = JSON.parse(existing) as FlushResult;
        if (result.requestId === requestId) {
          finish(result);
        }
      }
    } catch {
      /* ignore */
    }
  });
}

export function writeFlushResult(result: FlushResult): void {
  localStorage.setItem(FLUSH_RESULT_KEY, JSON.stringify(result));
}
