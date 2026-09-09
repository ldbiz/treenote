import { describe, expect, it } from "vitest";
import {
  buildInsertBeforeMove,
  buildReparentMove,
  buildSiblingReorderMove,
  type FlatMoveItem,
} from "./treeMove";

const items: FlatMoveItem[] = [
  { value: "root-a", parentValue: undefined },
  { value: "root-b", parentValue: undefined },
  { value: "child-1", parentValue: "root-a" },
  { value: "child-2", parentValue: "root-a" },
  { value: "grand-1", parentValue: "child-1" },
];

describe("buildInsertBeforeMove", () => {
  it("inserts before a sibling within the same parent", () => {
    const result = buildInsertBeforeMove(items, "child-2", "child-1");
    expect(result).not.toBeNull();
    expect(result?.parentId).toBe("root-a");
    expect(result?.sortOrder).toBe(0);
    expect(result?.items.map((item) => item.value)).toEqual([
      "root-a",
      "root-b",
      "child-2",
      "child-1",
      "grand-1",
    ]);
  });

  it("moves a subtree to become a root sibling before another root", () => {
    const result = buildInsertBeforeMove(items, "child-1", "root-b");
    expect(result).not.toBeNull();
    expect(result?.parentId).toBeNull();
    expect(result?.sortOrder).toBe(1);
    expect(result?.items.map((item) => item.value)).toEqual([
      "root-a",
      "child-1",
      "grand-1",
      "root-b",
      "child-2",
    ]);
  });

  it("rejects inserting before a descendant", () => {
    expect(buildInsertBeforeMove(items, "root-a", "grand-1")).toBeNull();
  });

  it("returns null for a no-op adjacent move", () => {
    expect(buildInsertBeforeMove(items, "child-1", "child-2")).toBeNull();
  });
});

describe("buildReparentMove", () => {
  it("still appends as the last child when dropping onto a node", () => {
    const result = buildReparentMove(items, "child-2", "root-b");
    expect(result).not.toBeNull();
    expect(result?.sortOrder).toBe(0);
    expect(result?.items.map((item) => item.value)).toEqual([
      "root-a",
      "root-b",
      "child-2",
      "child-1",
      "grand-1",
    ]);
  });
});

describe("buildSiblingReorderMove", () => {
  it("moves a node up among siblings", () => {
    const result = buildSiblingReorderMove(items, "child-2", "up");
    expect(result).not.toBeNull();
    expect(result?.sortOrder).toBe(0);
    expect(result?.parentId).toBe("root-a");
  });
});
