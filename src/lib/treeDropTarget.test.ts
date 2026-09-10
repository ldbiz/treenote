import { describe, expect, it } from "vitest";
import type {
  CollisionDetection,
  UniqueIdentifier,
} from "@dnd-kit/core";
import {
  BEFORE_DROP_PREFIX,
  ROOT_DROP_AREA_ID,
  beforeDropId,
  createTreeDropCollision,
  isBeforeDropId,
  nodeIdFromBeforeDropId,
} from "./treeDropTarget";

describe("treeDropTarget ids", () => {
  it("builds and parses before-drop ids", () => {
    const id = beforeDropId("node-1");
    expect(id).toBe(`${BEFORE_DROP_PREFIX}node-1`);
    expect(isBeforeDropId(id)).toBe(true);
    expect(nodeIdFromBeforeDropId(id)).toBe("node-1");
  });

  it("recognises the root drop area id", () => {
    expect(ROOT_DROP_AREA_ID).toBe("root-drop-area");
  });
});

type CollisionArgs = Parameters<CollisionDetection>[0];

function clientRect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

function droppable(id: UniqueIdentifier, rect: ReturnType<typeof clientRect>) {
  return {
    id,
    key: id,
    disabled: false,
    data: { current: undefined },
    node: { current: null },
    rect: { current: rect },
  };
}

function collisionArgs({
  activeId,
  containers,
  pointer,
  collisionRect,
}: {
  activeId: UniqueIdentifier;
  containers: ReturnType<typeof droppable>[];
  pointer: { x: number; y: number } | null;
  collisionRect?: ReturnType<typeof clientRect>;
}): CollisionArgs {
  const droppableRects = new Map(
    containers.map((container) => [container.id, container.rect.current!]),
  );
  return {
    active: {
      id: activeId,
      data: { current: undefined },
      rect: { current: { initial: null, translated: null } },
    },
    collisionRect: collisionRect ?? clientRect(pointer?.x ?? 0, pointer?.y ?? 0, 10, 10),
    droppableRects,
    droppableContainers: containers,
    pointerCoordinates: pointer,
  } as CollisionArgs;
}

const rowA = clientRect(0, 0, 400, 30);
const beforeA = clientRect(0, 0, 400, 10);
const rowB = clientRect(0, 30, 400, 30);
const beforeB = clientRect(0, 30, 400, 10);
const childA = clientRect(20, 60, 380, 30);
const beforeChildA = clientRect(20, 60, 380, 10);
const rootArea = clientRect(0, 0, 400, 400);

function standardContainers() {
  return [
    droppable(ROOT_DROP_AREA_ID, rootArea),
    droppable("A", rowA),
    droppable(beforeDropId("A"), beforeA),
    droppable("B", rowB),
    droppable(beforeDropId("B"), beforeB),
    droppable("child-a", childA),
    droppable(beforeDropId("child-a"), beforeChildA),
  ];
}

function firstHitId(result: ReturnType<CollisionDetection>) {
  return result[0]?.id;
}

describe("createTreeDropCollision", () => {
  const detect = createTreeDropCollision(new Set(["A", "child-a"]));

  it("prefers an insert-before zone over the containing row", () => {
    const result = detect(
      collisionArgs({
        activeId: "A",
        containers: standardContainers(),
        pointer: { x: 50, y: 35 },
      }),
    );
    expect(firstHitId(result)).toBe(beforeDropId("B"));
  });

  it("excludes the active node and its subtree as targets", () => {
    const overActive = detect(
      collisionArgs({
        activeId: "A",
        containers: standardContainers(),
        pointer: { x: 50, y: 20 },
      }),
    );
    expect(firstHitId(overActive)).not.toBe("A");
    expect(firstHitId(overActive)).not.toBe(beforeDropId("A"));

    const overChild = detect(
      collisionArgs({
        activeId: "A",
        containers: standardContainers(),
        pointer: { x: 50, y: 75 },
      }),
    );
    expect(firstHitId(overChild)).not.toBe("child-a");
    expect(firstHitId(overChild)).not.toBe(beforeDropId("child-a"));
  });

  it("resolves a row-body drop to onto the row", () => {
    const result = detect(
      collisionArgs({
        activeId: "A",
        containers: standardContainers(),
        pointer: { x: 50, y: 50 },
      }),
    );
    expect(firstHitId(result)).toBe("B");
  });

  it("falls back to the root drop area for empty space", () => {
    const outside = detect(
      collisionArgs({
        activeId: "A",
        containers: standardContainers(),
        pointer: { x: -20, y: -20 },
        collisionRect: clientRect(-20, -20, 10, 10),
      }),
    );
    expect(firstHitId(outside)).toBe(ROOT_DROP_AREA_ID);

    const inRootGap = detect(
      collisionArgs({
        activeId: "A",
        containers: standardContainers(),
        pointer: { x: 50, y: 300 },
      }),
    );
    expect(firstHitId(inRootGap)).toBe(ROOT_DROP_AREA_ID);
  });

  it("resolves overlapping candidates deterministically", () => {
    const pointer = { x: 50, y: 35 };
    const first = firstHitId(
      detect(
        collisionArgs({
          activeId: "A",
          containers: standardContainers(),
          pointer,
        }),
      ),
    );
    const reversed = firstHitId(
      detect(
        collisionArgs({
          activeId: "A",
          containers: [...standardContainers()].reverse(),
          pointer,
        }),
      ),
    );
    const again = firstHitId(
      detect(
        collisionArgs({
          activeId: "A",
          containers: standardContainers(),
          pointer,
        }),
      ),
    );
    expect(first).toBe(beforeDropId("B"));
    expect(reversed).toBe(first);
    expect(again).toBe(first);
  });
});
