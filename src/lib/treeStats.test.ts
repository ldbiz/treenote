import { describe, expect, it } from "vitest";
import {
  countDescendants,
  formatSubtreeStats,
  type TreeStatsItem,
} from "./treeStats";

const items: TreeStatsItem[] = [
  { value: "root-a" },
  { value: "root-b" },
  { value: "child-1", parentValue: "root-a" },
  { value: "child-2", parentValue: "root-a" },
  { value: "grand-1", parentValue: "child-1" },
  { value: "grand-2", parentValue: "child-1" },
  { value: "great", parentValue: "grand-1" },
];

describe("countDescendants", () => {
  it("returns 0 for a leaf", () => {
    expect(countDescendants(items, "grand-2")).toBe(0);
  });

  it("counts direct and nested descendants for a parent", () => {
    expect(countDescendants(items, "root-a")).toBe(5);
  });

  it("counts nested descendants", () => {
    expect(countDescendants(items, "child-1")).toBe(3);
  });

  it("returns 0 for an unknown id", () => {
    expect(countDescendants(items, "missing")).toBe(0);
  });

  it("terminates on cyclic parent links", () => {
    const cyclic: TreeStatsItem[] = [
      { value: "a", parentValue: "b" },
      { value: "b", parentValue: "a" },
      { value: "c", parentValue: "a" },
    ];
    expect(countDescendants(cyclic, "a")).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(countDescendants(cyclic, "a"))).toBe(true);
  });
});

describe("formatSubtreeStats", () => {
  it("describes a leaf", () => {
    expect(formatSubtreeStats(0, false)).toBe("No child notes");
  });

  it("uses singular branch wording", () => {
    expect(formatSubtreeStats(1, false)).toBe("1 note in this branch");
  });

  it("uses plural branch wording", () => {
    expect(formatSubtreeStats(12, false)).toBe("12 notes in this branch");
  });

  it("uses singular tree wording for root", () => {
    expect(formatSubtreeStats(1, true)).toBe("1 note in this tree");
  });

  it("uses plural tree wording for root", () => {
    expect(formatSubtreeStats(12, true)).toBe("12 notes in this tree");
  });
});
