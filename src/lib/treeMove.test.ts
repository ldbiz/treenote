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

const abc: FlatMoveItem[] = [
  { value: "A", parentValue: undefined },
  { value: "B", parentValue: undefined },
  { value: "C", parentValue: undefined },
];

describe("buildInsertBeforeMove", () => {
  it("moves a sibling upward within the same parent", () => {
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

  it("moves a sibling downward within the same parent", () => {
    const result = buildInsertBeforeMove(abc, "A", "C");
    expect(result).not.toBeNull();
    expect(result?.parentId).toBeNull();
    expect(result?.sortOrder).toBe(1);
    expect(result?.items.map((item) => item.value)).toEqual(["B", "A", "C"]);
  });

  it("returns null for an adjacent true no-op", () => {
    expect(buildInsertBeforeMove(abc, "A", "B")).toBeNull();
    expect(buildInsertBeforeMove(items, "child-1", "child-2")).toBeNull();
  });

  it("allows a non-adjacent downward move", () => {
    const four: FlatMoveItem[] = [
      { value: "A", parentValue: undefined },
      { value: "B", parentValue: undefined },
      { value: "C", parentValue: undefined },
      { value: "D", parentValue: undefined },
    ];
    const result = buildInsertBeforeMove(four, "A", "D");
    expect(result).not.toBeNull();
    expect(result?.sortOrder).toBe(2);
    expect(result?.items.map((item) => item.value)).toEqual(["B", "C", "A", "D"]);
  });

  it("inserts across parents", () => {
    const result = buildInsertBeforeMove(items, "root-b", "child-2");
    expect(result).not.toBeNull();
    expect(result?.parentId).toBe("root-a");
    expect(result?.sortOrder).toBe(1);
    expect(result?.items.map((item) => item.value)).toEqual([
      "root-a",
      "child-1",
      "root-b",
      "child-2",
      "grand-1",
    ]);
  });

  it("outdents a subtree to a root sibling slot", () => {
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

  it("preserves subtree internal order when moving", () => {
    const nested: FlatMoveItem[] = [
      { value: "root-a", parentValue: undefined },
      { value: "child-1", parentValue: "root-a" },
      { value: "grand-1", parentValue: "child-1" },
      { value: "great-1", parentValue: "grand-1" },
      { value: "grand-2", parentValue: "child-1" },
      { value: "root-b", parentValue: undefined },
    ];
    const result = buildInsertBeforeMove(nested, "child-1", "root-b");
    expect(result).not.toBeNull();
    const ids = result?.items.map((item) => item.value) ?? [];
    const start = ids.indexOf("child-1");
    expect(ids.slice(start, start + 4)).toEqual([
      "child-1",
      "grand-1",
      "great-1",
      "grand-2",
    ]);
    expect(result?.items.find((item) => item.value === "grand-1")?.parentValue).toBe(
      "child-1",
    );
    expect(result?.items.find((item) => item.value === "great-1")?.parentValue).toBe(
      "grand-1",
    );
  });

  it("rejects inserting before a descendant", () => {
    expect(buildInsertBeforeMove(items, "root-a", "grand-1")).toBeNull();
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
