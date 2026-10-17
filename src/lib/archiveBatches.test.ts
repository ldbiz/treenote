import { describe, expect, it } from "vitest";
import { ARCHIVE_BATCH_SIZE, archiveBatch } from "./archiveBatches";

const candidates = Array.from({ length: 200 }, (_, i) => ({
  id: "branch-" + (i + 1),
  noteCount: 1,
}));

describe("archive batches", () => {
  it("shows fixed groups of 20 for 200 branches", () => {
    expect(ARCHIVE_BATCH_SIZE).toBe(20);
    const first = archiveBatch(candidates, 0);
    const middle = archiveBatch(candidates, 5);
    const last = archiveBatch(candidates, 9);
    expect([first.pageCount, first.firstItem, first.lastItem]).toEqual([10, 1, 20]);
    expect([middle.pageIndex, middle.firstItem, middle.lastItem]).toEqual([5, 101, 120]);
    expect([last.firstItem, last.lastItem]).toEqual([181, 200]);
    expect(first.candidates[0]).toBe(candidates[0]);
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

  it("keeps later group positions stable when the review data is unchanged", () => {
    const original = candidates.slice();
    const page = archiveBatch(original, 1);
    expect(page.candidates.map((b) => b.id)).toEqual(
      candidates.slice(20, 40).map((b) => b.id),
    );
    // Archiving group 1 does not delete it from the initial session snapshot.
    expect(archiveBatch(original, 1).candidates).toEqual(page.candidates);
  });

  it("rejects invalid batch sizes", () => {
    expect(() => archiveBatch(candidates, 0, 0)).toThrow();
    expect(() => archiveBatch(candidates, 0, -5)).toThrow();
  });
});
