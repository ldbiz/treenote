import { describe, expect, it } from "vitest";
import {
  ARCHIVE_BATCH_SIZE,
  archiveBatch,
  reconcileArchiveSelection,
  selectedArchiveBatchIds,
  setArchiveBatchSelection,
} from "./archiveBatches";

const candidates = Array.from({ length: 200 }, (_, i) => ({
  id: "branch-" + (i + 1),
  noteCount: 1,
}));

describe("archive batches", () => {
  it("shows 20 branches per page for a 200-branch notebook", () => {
    expect(ARCHIVE_BATCH_SIZE).toBe(20);
    const first = archiveBatch(candidates, 0);
    const middle = archiveBatch(candidates, 5);
    const last = archiveBatch(candidates, 9);
    expect([first.pageCount, first.firstItem, first.lastItem]).toEqual([10, 1, 20]);
    expect([middle.pageIndex, middle.firstItem, middle.lastItem]).toEqual([5, 101, 120]);
    expect([last.firstItem, last.lastItem]).toEqual([181, 200]);
    expect(archiveBatch(candidates, 20).pageIndex).toBe(9);
    expect(archiveBatch(candidates, -10).pageIndex).toBe(0);
  });

  it("handles empty and partial final groups", () => {
    expect(archiveBatch([], 5)).toMatchObject({
      pageIndex: 0, pageCount: 1, firstItem: 0, lastItem: 0, candidates: [],
    });
    const last = archiveBatch(candidates.slice(0, 43), 2);
    expect([last.firstItem, last.lastItem, last.candidates.length]).toEqual([41, 43, 3]);
  });

  it("archives only checked candidates from the current group", () => {
    const selected = new Set(candidates.map((c) => c.id));
    const first = archiveBatch(candidates, 0).candidates;
    const second = archiveBatch(candidates, 1).candidates;
    const excluded = setArchiveBatchSelection(selected, first, false);
    expect(selectedArchiveBatchIds(first, excluded)).toEqual([]);
    expect(selectedArchiveBatchIds(second, excluded)).toHaveLength(20);
    const restored = setArchiveBatchSelection(excluded, first, true);
    expect(selectedArchiveBatchIds(first, restored)).toHaveLength(20);
  });

  it("does not send selected branches from other pages to archive", () => {
    const allSelected = new Set(candidates.map((candidate) => candidate.id));
    const page = archiveBatch(candidates, 4).candidates;
    expect(selectedArchiveBatchIds(page, allSelected)).toEqual(
      candidates.slice(80, 100).map((candidate) => candidate.id),
    );
  });

  it("preserves exclusions across batch execution and refresh", () => {
    const selected = new Set(candidates.map((candidate) => candidate.id));
    selected.delete("branch-50");
    const remaining = candidates.slice(20); // first 20 were archived
    const refreshed = reconcileArchiveSelection(candidates, selected, remaining);
    expect(refreshed.has("branch-50")).toBe(false);
    expect(refreshed.has("branch-21")).toBe(true);
    expect(refreshed.has("branch-1")).toBe(false);
    expect(refreshed.size).toBe(179);
    const newCandidate = { id: "new-eligible-branch", noteCount: 3 };
    expect(reconcileArchiveSelection(candidates, selected, [...remaining, newCandidate]).has(newCandidate.id)).toBe(true);
  });

  it("clamps the reviewed page as remaining groups shrink", () => {
    expect(archiveBatch(candidates.slice(0, 180), 9).pageIndex).toBe(8);
    expect(archiveBatch(candidates.slice(0, 160), 8).pageIndex).toBe(7);
  });

  it("rejects invalid batch sizes", () => {
    expect(() => archiveBatch(candidates, 0, 0)).toThrow();
    expect(() => archiveBatch(candidates, 0, -5)).toThrow();
  });
});
