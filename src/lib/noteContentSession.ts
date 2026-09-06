/**
 * Revision-aware note content persistence session.
 * Pure logic for sequencing loads/saves; no React or Tauri dependencies.
 */

export type SaveFn = (id: string, content: string) => Promise<void>;

export type SessionSnapshot = {
  loadedId: string | null;
  text: string;
  editRevision: number;
  savedRevision: number;
  loadGeneration: number;
  saveError: string | null;
  loadError: string | null;
  isLoading: boolean;
};

export type NoteContentSessionOptions = {
  onNotify?: () => void;
};

export type NoteContentSession = {
  getSnapshot: () => SessionSnapshot;
  beginLoad: (nodeId: string | null) => number;
  applyLoadResult: (
    generation: number,
    nodeId: string,
    content: string,
  ) => void;
  applyLoadFailure: (generation: number) => void;
  edit: (text: string) => void;
  scheduleDebouncedSave: (delayMs: number) => void;
  cancelDebounce: () => void;
  persistLatest: () => Promise<void>;
  flush: () => Promise<void>;
  isDirty: () => boolean;
};

export function createNoteContentSession(
  saveFn: SaveFn,
  options: NoteContentSessionOptions = {},
): NoteContentSession {
  let loadedId: string | null = null;
  let text = "";
  let editRevision = 0;
  let savedRevision = 0;
  let loadGeneration = 0;
  let saveError: string | null = null;
  let loadError: string | null = null;
  let isLoading = false;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let activeSave: Promise<void> | null = null;

  const notify = () => {
    options.onNotify?.();
  };

  const getSnapshot = (): SessionSnapshot => ({
    loadedId,
    text,
    editRevision,
    savedRevision,
    loadGeneration,
    saveError,
    loadError,
    isLoading,
  });

  const isDirty = () =>
    loadedId !== null && editRevision !== savedRevision;

  const runSave = async (revision: number, content: string): Promise<void> => {
    if (loadedId === null) return;
    try {
      await saveFn(loadedId, content);
      saveError = null;
      if (revision > savedRevision) {
        savedRevision = revision;
      }
    } catch {
      saveError = "Couldn't save this note.";
      throw new Error(saveError);
    } finally {
      notify();
    }
  };

  const drainDirty = async (): Promise<void> => {
    while (isDirty()) {
      const revision = editRevision;
      const content = text;
      await runSave(revision, content);
    }
  };

  const flush = async (): Promise<void> => {
    cancelDebounce();
    try {
      if (activeSave) {
        await activeSave;
      }
      if (!isDirty()) {
        if (saveError) {
          throw new Error(saveError);
        }
        return;
      }
      activeSave = drainDirty().finally(() => {
        activeSave = null;
      });
      await activeSave;
      if (saveError) {
        throw new Error(saveError);
      }
    } finally {
      notify();
    }
  };

  const beginLoad = (nodeId: string | null): number => {
    cancelDebounce();
    loadGeneration += 1;
    const gen = loadGeneration;
    if (nodeId === null) {
      loadedId = null;
      text = "";
      editRevision = 0;
      savedRevision = 0;
      isLoading = false;
      loadError = null;
      notify();
      return gen;
    }
    isLoading = true;
    loadError = null;
    notify();
    return gen;
  };

  const applyLoadResult = (
    generation: number,
    nodeId: string,
    content: string,
  ): void => {
    if (generation !== loadGeneration) return;
    loadedId = nodeId;
    text = content;
    editRevision = 0;
    savedRevision = 0;
    isLoading = false;
    loadError = null;
    saveError = null;
    notify();
  };

  const applyLoadFailure = (generation: number): void => {
    if (generation !== loadGeneration) return;
    isLoading = false;
    loadError = "Couldn't load this note.";
    notify();
  };

  const edit = (newText: string): void => {
    if (loadedId === null || isLoading) return;
    text = newText;
    editRevision += 1;
    saveError = null;
    notify();
  };

  const cancelDebounce = (): void => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const scheduleDebouncedSave = (delayMs: number): void => {
    cancelDebounce();
    if (loadedId === null || !isDirty()) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void flush().catch(() => {
        /* saveError recorded in runSave; flush notifies */
      });
    }, delayMs);
  };

  return {
    getSnapshot,
    beginLoad,
    applyLoadResult,
    applyLoadFailure,
    edit,
    scheduleDebouncedSave,
    cancelDebounce,
    persistLatest: flush,
    flush,
    isDirty,
  };
}
