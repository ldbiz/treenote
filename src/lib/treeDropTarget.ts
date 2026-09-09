import {
  closestCenter,
  pointerWithin,
  type CollisionDetection,
  type UniqueIdentifier,
} from "@dnd-kit/core";

export const ROOT_DROP_AREA_ID = "root-drop-area";
export const BEFORE_DROP_PREFIX = "before:";

export function beforeDropId(nodeId: UniqueIdentifier): string {
  return `${BEFORE_DROP_PREFIX}${String(nodeId)}`;
}

export function isBeforeDropId(id: UniqueIdentifier): boolean {
  return String(id).startsWith(BEFORE_DROP_PREFIX);
}

export function nodeIdFromBeforeDropId(id: UniqueIdentifier): UniqueIdentifier {
  return String(id).slice(BEFORE_DROP_PREFIX.length);
}

function droppableContainers(args: Parameters<CollisionDetection>[0]) {
  return args.droppableContainers.filter((container) => {
    const id = String(container.id);
    return id !== String(args.active.id) && !id.startsWith(BEFORE_DROP_PREFIX + String(args.active.id));
  });
}

function area(container: { rect: { current: { width: number; height: number } | null } }): number {
  const rect = container.rect.current;
  if (!rect) return Number.MAX_SAFE_INTEGER;
  return rect.width * rect.height;
}

function pickPreferredDropId(
  hits: ReturnType<typeof pointerWithin>,
  containers: Parameters<CollisionDetection>[0]["droppableContainers"],
): UniqueIdentifier | null {
  if (hits.length === 0) return null;
  const hitIds = new Set(hits.map((hit) => hit.id));
  const candidates = containers.filter((container) => hitIds.has(container.id));
  if (candidates.length === 0) return hits[0]?.id ?? null;
  candidates.sort((a, b) => area(a) - area(b));
  return candidates[0]?.id ?? null;
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

    const filteredArgs = { ...args, droppableContainers: allowed };
    const pointerHits = args.pointerCoordinates ? pointerWithin(filteredArgs) : [];
    const preferred = pickPreferredDropId(pointerHits, allowed);
    if (preferred != null) {
      const match = pointerHits.find((hit) => hit.id === preferred);
      if (match) return [match];
    }

    const centerHits = closestCenter(filteredArgs);
    const rootHit = centerHits.find((hit) => hit.id === ROOT_DROP_AREA_ID);
    if (rootHit) return [rootHit];
    return centerHits.slice(0, 1);
  };
}
