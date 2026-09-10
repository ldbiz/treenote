import {
  closestCenter,
  type ClientRect,
  type CollisionDetection,
  type UniqueIdentifier,
} from "@dnd-kit/core";

export const ROOT_DROP_AREA_ID = "root-drop-area";
export const BEFORE_DROP_PREFIX = "before:";

type CollisionArgs = Parameters<CollisionDetection>[0];
type DropContainer = CollisionArgs["droppableContainers"][number];

export function beforeDropId(nodeId: UniqueIdentifier): string {
  return `${BEFORE_DROP_PREFIX}${String(nodeId)}`;
}

export function isBeforeDropId(id: UniqueIdentifier): boolean {
  return String(id).startsWith(BEFORE_DROP_PREFIX);
}

export function nodeIdFromBeforeDropId(id: UniqueIdentifier): UniqueIdentifier {
  return String(id).slice(BEFORE_DROP_PREFIX.length);
}

function droppableContainers(args: CollisionArgs) {
  return args.droppableContainers.filter((container) => {
    const id = String(container.id);
    return id !== String(args.active.id) && !id.startsWith(BEFORE_DROP_PREFIX + String(args.active.id));
  });
}

/**
 * Measure the container as it is on screen right now. dnd-kit caches droppable
 * rects when the drag starts, so anything that moves rows mid-drag (scrolling,
 * an expanding branch, a resized panel) leaves those rects pointing at stale
 * positions and the drop resolves to the wrong row.
 */
function currentRect(container: DropContainer, args: CollisionArgs): ClientRect | null {
  const node = container.node.current;
  if (node) {
    return node.getBoundingClientRect();
  }
  return args.droppableRects.get(container.id) ?? container.rect.current;
}

function containsPoint(rect: ClientRect, point: { x: number; y: number }): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

function area(rect: ClientRect): number {
  return rect.width * rect.height;
}

function rootCollision(containers: DropContainer[]) {
  const root = containers.find((container) => String(container.id) === ROOT_DROP_AREA_ID);
  if (!root) return [];
  return [{ id: root.id, data: { droppableContainer: root, value: 0 } }];
}

/**
 * Resolve the drop from the pointer position against live geometry. The
 * smallest container under the cursor wins, so the thin insert-before strip
 * beats the full row it sits on.
 */
function pointerCollision(args: CollisionArgs, containers: DropContainer[]) {
  const pointer = args.pointerCoordinates;
  if (!pointer) return null;

  const hits: { container: DropContainer; rect: ClientRect }[] = [];
  for (const container of containers) {
    const rect = currentRect(container, args);
    if (rect && containsPoint(rect, pointer)) {
      hits.push({ container, rect });
    }
  }
  if (hits.length === 0) return rootCollision(containers);

  hits.sort(
    (a, b) =>
      area(a.rect) - area(b.rect) ||
      String(a.container.id).localeCompare(String(b.container.id)),
  );
  const best = hits[0];
  return [{ id: best.container.id, data: { droppableContainer: best.container, value: 0 } }];
}

export function createTreeDropCollision(activeSubtreeIds: Set<string>): CollisionDetection {
  return (args) => {
    const allowed = droppableContainers(args).filter((container) => {
      const id = String(container.id);
      if (id === ROOT_DROP_AREA_ID) return true;
      if (isBeforeDropId(container.id)) {
        const nodeId = String(nodeIdFromBeforeDropId(container.id));
        return !activeSubtreeIds.has(nodeId);
      }
      return !activeSubtreeIds.has(id);
    });

    const pointerHit = pointerCollision(args, allowed);
    if (pointerHit) return pointerHit;

    // Keyboard dragging has no pointer, so fall back to rect proximity.
    const centerHits = closestCenter({ ...args, droppableContainers: allowed });
    const rootHit = centerHits.find((hit) => hit.id === ROOT_DROP_AREA_ID);
    if (rootHit) return [rootHit];
    return centerHits.slice(0, 1);
  };
}
