import { describe, expect, it } from "vitest";
import { createNoteSelectionQueue } from "./noteSelection";
import { createNoteContentSession, type SaveFn } from "./noteContentSession";

describe("noteSelection", () => {
  it("rapid A→B→C commits in order after serialised flushes", async () => {
    const flushLog: string[] = [];
    let loadedId = "start";
    const flush = async () => {
      flushLog.push(loadedId);
    };
    const committed: string[] = [];
    const select = createNoteSelectionQueue(flush, (id) => {
      committed.push(id);
      loadedId = id;
    });

    select("a");
    select("b");
    select("c");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(committed).toEqual(["a", "b", "c"]);
    expect(flushLog).toEqual(["start", "a", "b"]);
  });

  it("does not change selection when flush fails", async () => {
    const committed: string[] = [];
    const select = createNoteSelectionQueue(
      async () => {
        throw new Error("flush failed");
      },
      (id) => committed.push(id),
    );

    select("a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(committed).toEqual([]);
  });

  it("serialised selection flushes before loading the next note", async () => {
    const saved: Array<{ id: string; content: string }> = [];
    let releaseSave: (() => void) | undefined;
    const saveFn: SaveFn = async (id, content) => {
      if (id === "a") {
        await new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
      }
      saved.push({ id, content });
    };
    const session = createNoteContentSession(saveFn);
    const genA = session.beginLoad("a");
    session.applyLoadResult(genA, "a", "");
    session.edit("edit-a");

    const select = createNoteSelectionQueue(
      () => session.flush(),
      (id) => {
        const gen = session.beginLoad(id);
        session.applyLoadResult(gen, id, `body-${id}`);
      },
    );

    select("b");
    select("c");
    expect(saved).toEqual([]);
    await Promise.resolve();
    releaseSave?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      saved.some((entry) => entry.id === "a" && entry.content === "edit-a"),
    ).toBe(true);
    expect(saved.some((entry) => entry.id !== "a")).toBe(false);
    expect(session.getSnapshot().loadedId).toBe("c");
    expect(session.getSnapshot().text).toBe("body-c");
  });
});
