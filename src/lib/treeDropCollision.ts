import {
  closestCenter,
  pointerWithin,
  type Collision,
  type CollisionDetection,
  type UniqueIdentifier,
} from "@dnd-kit/core";

export const ROOT_DROP_AREA_ID = "root-drop-area";

export function pickPreferredTreeDropId(
  pointerHitIds: UniqueIdentifier[],
  rectAreaById: Map<UniqueIdentifier, number>,
): UniqueIdentifier | null {
  const itemIds = pointerHitIds.filter((id) => id !== ROOT_DROP_AREA_ID);
  if (itemIds.length === 1) return itemIds[0];
  if (itemIds.length > 1) {
    return itemIds.reduce((best, id) => {
      const area = rectAreaById.get(id) ?? Number.POSITIVE_INFINITY;
      const bestArea = rectAreaById.get(best) ?? Number.POSITIVE_INFINITY;
      return area < bestArea ? id : best;
    });
  }
  if (pointerHitIds.includes(ROOT_DROP_AREA_ID)) return ROOT_DROP_AREA_ID;
  return null;
}

export const detectTreeDropCollision: CollisionDetection = (args) => {
  const pointerHits: Collision[] = args.pointerCoordinates
    ? pointerWithin(args)
    : [];
  const preferred = pickPreferredTreeDropId(
    pointerHits.map((collision) => collision.id),
    new Map(
      pointerHits.map((collision) => {
        const rect = args.droppableRects.get(collision.id);
        const area = rect
          ? rect.width * rect.height
          : Number.POSITIVE_INFINITY;
        return [collision.id, area];
      }),
    ),
  );
  if (preferred != null) {
    const match = pointerHits.find((collision) => collision.id === preferred);
    return match ? [match] : [];
  }

  const itemContainers = args.droppableContainers.filter(
    (container) => container.id !== ROOT_DROP_AREA_ID,
  );
  const closestItems = closestCenter({
    ...args,
    droppableContainers: itemContainers,
  });
  if (closestItems.length > 0) return closestItems;

  return closestCenter(args).filter(
    (collision) => collision.id === ROOT_DROP_AREA_ID,
  );
};
