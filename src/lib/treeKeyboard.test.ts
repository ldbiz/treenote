import { describe, expect, it } from "vitest";
import {
  computeTreePageSize,
  resolveTreeKeyboardAction,
  type TreeKeyboardInput,
  type TreeKeyboardItemMeta,
} from "./treeKeyboard";

const ids = ["root", "child-a", "child-b", "leaf"];

function meta(
  entries: Array<[string, TreeKeyboardItemMeta]>,
): Map<string, TreeKeyboardItemMeta> {
  return new Map(entries);
}

const treeMeta = meta([
  ["root", { parentId: null, hasChildren: true, isOpen: true }],
  ["child-a", { parentId: "root", hasChildren: false, isOpen: false }],
  ["child-b", { parentId: "root", hasChildren: true, isOpen: false }],
  ["leaf", { parentId: null, hasChildren: false, isOpen: false }],
]);

function action(
  overrides: Partial<TreeKeyboardInput> & Pick<TreeKeyboardInput, "key">,
) {
  return resolveTreeKeyboardAction({
    visibleIds: ids,
    itemMeta: treeMeta,
    currentId: "child-a",
    pageSize: 2,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  });
}

describe("computeTreePageSize", () => {
  it("returns 1 when height is invalid", () => {
    expect(computeTreePageSize(0, 32)).toBe(1);
    expect(computeTreePageSize(200, 0)).toBe(1);
  });

  it("uses floor(scroller / row) - 1, min 1", () => {
    expect(computeTreePageSize(320, 32)).toBe(9);
    expect(computeTreePageSize(40, 32)).toBe(1);
  });
});

describe("resolveTreeKeyboardAction", () => {
  it("moves down and stays on the last row", () => {
    expect(action({ key: "ArrowDown" })).toEqual({
      type: "select",
      id: "child-b",
    });
    expect(action({ key: "ArrowDown", currentId: "leaf" })).toEqual({
      type: "select",
      id: "leaf",
    });
  });

  it("moves up and stays on the first row", () => {
    expect(action({ key: "ArrowUp" })).toEqual({
      type: "select",
      id: "root",
    });
    expect(action({ key: "ArrowUp", currentId: "root" })).toEqual({
      type: "select",
      id: "root",
    });
  });

  it("Home and End jump to the first and last visible rows", () => {
    expect(action({ key: "Home" })).toEqual({ type: "select", id: "root" });
    expect(action({ key: "End" })).toEqual({ type: "select", id: "leaf" });
  });

  it("PageDown and PageUp jump by page size and clamp", () => {
    expect(action({ key: "PageDown", currentId: "root", pageSize: 2 })).toEqual({
      type: "select",
      id: "child-b",
    });
    expect(action({ key: "PageDown", currentId: "child-b", pageSize: 2 })).toEqual(
      { type: "select", id: "leaf" },
    );
    expect(action({ key: "PageUp", currentId: "leaf", pageSize: 2 })).toEqual({
      type: "select",
      id: "child-a",
    });
    expect(action({ key: "PageUp", currentId: "root", pageSize: 1 })).toEqual({
      type: "select",
      id: "root",
    });
  });

  it("Left collapses an open parent, otherwise selects the parent", () => {
    expect(action({ key: "ArrowLeft", currentId: "root" })).toEqual({
      type: "toggleOpen",
      id: "root",
    });
    expect(action({ key: "ArrowLeft", currentId: "child-a" })).toEqual({
      type: "select",
      id: "root",
    });
    expect(action({ key: "ArrowLeft", currentId: "leaf" })).toBeNull();
  });

  it("Right expands a collapsed parent, otherwise selects the first child", () => {
    expect(action({ key: "ArrowRight", currentId: "child-b" })).toEqual({
      type: "toggleOpen",
      id: "child-b",
    });
    expect(action({ key: "ArrowRight", currentId: "root" })).toEqual({
      type: "select",
      id: "child-a",
    });
    expect(action({ key: "ArrowRight", currentId: "leaf" })).toBeNull();
  });

  it("only walks visible rows when the tree is collapsed or filtered", () => {
    const visible = ["root", "leaf"];
    expect(
      action({
        key: "ArrowDown",
        currentId: "root",
        visibleIds: visible,
      }),
    ).toEqual({ type: "select", id: "leaf" });
    expect(
      action({
        key: "ArrowRight",
        currentId: "root",
        visibleIds: visible,
      }),
    ).toBeNull();
  });

  it("selects first or last visible row when nothing is selected", () => {
    expect(action({ key: "ArrowDown", currentId: null })).toEqual({
      type: "select",
      id: "root",
    });
    expect(action({ key: "ArrowUp", currentId: null })).toEqual({
      type: "select",
      id: "leaf",
    });
    expect(action({ key: "Delete", currentId: null })).toBeNull();
    expect(action({ key: "Enter", currentId: null })).toBeNull();
  });

  it("ignores modifier keys so zoom shortcuts still work", () => {
    expect(action({ key: "ArrowDown", ctrlKey: true })).toBeNull();
    expect(action({ key: "ArrowDown", altKey: true })).toBeNull();
    expect(action({ key: "Delete", metaKey: true })).toBeNull();
  });

  it("Delete and Enter act on the current node", () => {
    expect(action({ key: "Delete" })).toEqual({
      type: "delete",
      id: "child-a",
    });
    expect(action({ key: "Enter" })).toEqual({ type: "activate" });
    expect(action({ key: "Backspace" })).toBeNull();
  });
});
