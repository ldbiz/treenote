import { describe, expect, it, vi, afterEach } from "vitest";
import { createNoteContentSession, type SaveFn } from "./noteContentSession";

describe("noteContentSession", () => {
  it("flush persists all pending revisions when edits arrive during an in-flight save", async () => {
    const saves: string[] = [];
    let resolveFirst: (() => void) | undefined;
    const saveFn: SaveFn = async (_id, content) => {
      if (saves.length === 0) {
        await new Promise<void>((r) => {
          resolveFirst = r;
        });
      }
      saves.push(content);
    };
    const session = createNoteContentSession(saveFn);
    const gen = session.beginLoad("a");
    session.applyLoadResult(gen, "a", "");
    session.edit("v10");
    const done = session.flush();
    session.edit("v11");
    resolveFirst?.();
    await done;
    expect(saves).toEqual(["v10", "v11"]);
    expect(session.isDirty()).toBe(false);
  });

  it("newer edit while save is in flight coalesces to a follow-up save", async () => {
    const saves: string[] = [];
    let gate: (() => void) | undefined;
    const saveFn: SaveFn = async (_id, content) => {
      if (content === "first") {
        await new Promise<void>((r) => {
          gate = r;
        });
      }
      saves.push(content);
    };
    const session = createNoteContentSession(saveFn);
    const gen = session.beginLoad("n");
    session.applyLoadResult(gen, "n", "");
    session.edit("first");
    const done = session.flush();
    session.edit("second");
    gate?.();
    await done;
    expect(saves).toEqual(["first", "second"]);
  });

  it("flush waits for the latest required revision", async () => {
    const order: string[] = [];
    let firstGate: (() => void) | undefined;
    const saveFn: SaveFn = async (_id, content) => {
      if (content === "a") {
        await new Promise<void>((r) => {
          firstGate = r;
        });
      }
      order.push(content);
    };
    const session = createNoteContentSession(saveFn);
    const gen = session.beginLoad("x");
    session.applyLoadResult(gen, "x", "");
    session.edit("a");
    const firstFlush = session.flush();
    session.edit("b");
    const secondFlush = session.flush();
    firstGate?.();
    await Promise.all([firstFlush, secondFlush]);
    expect(order).toEqual(["a", "b"]);
    expect(session.isDirty()).toBe(false);
  });

  it("save failure retains text and dirty state", async () => {
    const saveFn: SaveFn = async () => {
      throw new Error("disk");
    };
    const session = createNoteContentSession(saveFn);
    const gen = session.beginLoad("id");
    session.applyLoadResult(gen, "id", "keep");
    session.edit("changed");
    await expect(session.flush()).rejects.toThrow();
    expect(session.getSnapshot().text).toBe("changed");
    expect(session.isDirty()).toBe(true);
    expect(session.getSnapshot().saveError).toBe("Couldn't save this note.");
  });

  it("stale load result is ignored", () => {
    const saveFn: SaveFn = async () => {};
    const session = createNoteContentSession(saveFn);
    const genA = session.beginLoad("a");
    const genB = session.beginLoad("b");
    session.applyLoadResult(genA, "a", "stale");
    expect(session.getSnapshot().loadedId).toBeNull();
    session.applyLoadResult(genB, "b", "fresh");
    expect(session.getSnapshot().text).toBe("fresh");
    expect(session.getSnapshot().loadedId).toBe("b");
  });

  it("load failure does not apply empty content as editable", () => {
    const saveFn: SaveFn = async () => {};
    const session = createNoteContentSession(saveFn);
    const gen = session.beginLoad("missing");
    session.applyLoadFailure(gen);
    expect(session.getSnapshot().loadError).toBe("Couldn't load this note.");
    expect(session.getSnapshot().isLoading).toBe(false);
  });

  it("notifies after debounced autosave failure", async () => {
    vi.useFakeTimers();
    let notifyCount = 0;
    let lastSaveError: string | null = null;
    const saveFn: SaveFn = async () => {
      throw new Error("disk");
    };
    const session = createNoteContentSession(saveFn, {
      onNotify: () => {
        notifyCount += 1;
        lastSaveError = session.getSnapshot().saveError;
      },
    });
    const gen = session.beginLoad("n");
    session.applyLoadResult(gen, "n", "start");
    session.edit("edited");
    session.scheduleDebouncedSave(500);
    await vi.advanceTimersByTimeAsync(500);
    await vi.runAllTimersAsync();
    expect(session.getSnapshot().saveError).toBe("Couldn't save this note.");
    expect(session.getSnapshot().text).toBe("edited");
    expect(session.isDirty()).toBe(true);
    expect(notifyCount).toBeGreaterThan(0);
    expect(lastSaveError).toBe("Couldn't save this note.");
    vi.useRealTimers();
  });

  it("notifies when a later successful save clears saveError", async () => {
    let shouldFail = true;
    let saveError: string | null = null;
    const saveFn: SaveFn = async () => {
      if (shouldFail) {
        throw new Error("disk");
      }
    };
    const session = createNoteContentSession(saveFn, {
      onNotify: () => {
        saveError = session.getSnapshot().saveError;
      },
    });
    const gen = session.beginLoad("n");
    session.applyLoadResult(gen, "n", "");
    session.edit("first");
    await expect(session.flush()).rejects.toThrow();
    expect(saveError).toBe("Couldn't save this note.");

    shouldFail = false;
    await session.flush();
    expect(saveError).toBeNull();
    expect(session.isDirty()).toBe(false);
  });

  it("flush sync pattern preserves UI-visible saveError on failure", async () => {
    const saveFn: SaveFn = async () => {
      throw new Error("disk");
    };
    const session = createNoteContentSession(saveFn);
    const gen = session.beginLoad("id");
    session.applyLoadResult(gen, "id", "keep");
    session.edit("changed");

    let uiSaveError: string | null = null;
    const syncFromSession = () => {
      uiSaveError = session.getSnapshot().saveError;
    };

    let flushFailed = false;
    try {
      await session.flush();
    } catch {
      flushFailed = true;
    } finally {
      syncFromSession();
    }

    expect(flushFailed).toBe(true);
    expect(uiSaveError).toBe("Couldn't save this note.");
    expect(session.getSnapshot().text).toBe("changed");
    expect(session.isDirty()).toBe(true);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
