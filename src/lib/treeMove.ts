import type { UniqueIdentifier } from "@dnd-kit/core";

export type FlatMoveItem = {
  value: UniqueIdentifier;
  parentValue?: UniqueIdentifier;
  layout?: string;
};

export type ReparentMoveResult = {
  items: FlatMoveItem[];
  sortOrder: number;
  openParentId?: UniqueIdentifier;
};

export type InsertBeforeMoveResult = {
  items: FlatMoveItem[];
  parentId: string | null;
  sortOrder: number;
  openParentId?: UniqueIdentifier;
};

export type SiblingReorderResult = {
  items: FlatMoveItem[];
  parentId: string | null;
  sortOrder: number;
};

export const isDescendant = (
  itemId: UniqueIdentifier,
  parentId: UniqueIdentifier,
  items: FlatMoveItem[],
): boolean => {
  const itemMap = new Map(items.map((item) => [item.value, item]));
  let current = itemMap.get(itemId);
  while (current?.parentValue) {
    if (current.parentValue === parentId) {
      return true;
    }
    current = itemMap.get(current.parentValue);
  }
  return false;
};

export const getAllDescendants = (
  nodeId: UniqueIdentifier,
  items: FlatMoveItem[],
): Map<UniqueIdentifier, FlatMoveItem> => {
  const descendants = new Map<UniqueIdentifier, FlatMoveItem>();
  const directChildren = items.filter((item) => item.parentValue === nodeId);
  directChildren.forEach((child) => {
    descendants.set(child.value, child);
    getAllDescendants(child.value, items).forEach((descendant, id) => {
      descendants.set(id, descendant);
    });
  });
  return descendants;
};

export const countSiblings = (
  items: FlatMoveItem[],
  parentValue: UniqueIdentifier | undefined,
): number => items.filter((item) => item.parentValue === parentValue).length;

const siblingIndex = (
  items: FlatMoveItem[],
  nodeId: UniqueIdentifier,
): number => {
  const item = items.find((entry) => entry.value === nodeId);
  if (!item) return -1;
  const siblings = items.filter((entry) => entry.parentValue === item.parentValue);
  return siblings.findIndex((entry) => entry.value === nodeId);
};

const insertSubtreeAt = (
  itemsWithoutActiveTree: FlatMoveItem[],
  insertionIndex: number,
  activeItem: FlatMoveItem,
  activeItemDescendants: Map<UniqueIdentifier, FlatMoveItem>,
): FlatMoveItem[] => [
  ...itemsWithoutActiveTree.slice(0, insertionIndex),
  activeItem,
  ...Array.from(activeItemDescendants.values()),
  ...itemsWithoutActiveTree.slice(insertionIndex),
];

export const buildReparentMove = (
  prevItems: FlatMoveItem[],
  activeId: UniqueIdentifier,
  newParentValue: UniqueIdentifier | undefined,
): ReparentMoveResult | null => {
  const activeItem = prevItems.find((item) => item.value === activeId);
  if (!activeItem) return null;

  if (
    newParentValue !== undefined &&
    isDescendant(newParentValue, activeId, prevItems)
  ) {
    return null;
  }

  const activeItemDescendants = getAllDescendants(activeId, prevItems);
  const itemsWithoutActiveTree = prevItems.filter(
    (item) =>
      item.value !== activeId &&
      !activeItemDescendants.has(item.value as UniqueIdentifier),
  );

  const updatedActiveItem = {
    ...activeItem,
    parentValue: newParentValue,
  };

  let nextItems: FlatMoveItem[];
  let openParentId: UniqueIdentifier | undefined;

  if (newParentValue === undefined) {
    nextItems = insertSubtreeAt(
      itemsWithoutActiveTree,
      itemsWithoutActiveTree.length,
      updatedActiveItem,
      activeItemDescendants,
    );
  } else {
    const overIndex = itemsWithoutActiveTree.findIndex(
      (item) => item.value === newParentValue,
    );
    if (overIndex === -1) return null;

    let lastChildIndex = -1;
    for (let i = overIndex + 1; i < itemsWithoutActiveTree.length; i++) {
      const currentItem = itemsWithoutActiveTree[i];
      if (currentItem.parentValue !== newParentValue) {
        break;
      }
      lastChildIndex = i;
    }

    const insertionIndex =
      lastChildIndex !== -1 ? lastChildIndex + 1 : overIndex + 1;

    nextItems = insertSubtreeAt(
      itemsWithoutActiveTree,
      insertionIndex,
      updatedActiveItem,
      activeItemDescendants,
    );
    openParentId = newParentValue;
  }

  return {
    items: nextItems,
    sortOrder: countSiblings(itemsWithoutActiveTree, newParentValue),
    openParentId,
  };
};

export const buildInsertBeforeMove = (
  prevItems: FlatMoveItem[],
  activeId: UniqueIdentifier,
  referenceId: UniqueIdentifier,
): InsertBeforeMoveResult | null => {
  const activeItem = prevItems.find((item) => item.value === activeId);
  const referenceItem = prevItems.find((item) => item.value === referenceId);
  if (!activeItem || !referenceItem) return null;

  const newParentValue = referenceItem.parentValue;
  if (
    newParentValue !== undefined &&
    (newParentValue === activeId || isDescendant(newParentValue, activeId, prevItems))
  ) {
    return null;
  }

  const activeItemDescendants = getAllDescendants(activeId, prevItems);
  const itemsWithoutActiveTree = prevItems.filter(
    (item) =>
      item.value !== activeId &&
      !activeItemDescendants.has(item.value as UniqueIdentifier),
  );

  const referenceIndex = itemsWithoutActiveTree.findIndex(
    (item) => item.value === referenceId,
  );
  if (referenceIndex === -1) return null;

  const oldParent = activeItem.parentValue;
  const j = siblingIndex(itemsWithoutActiveTree, referenceId);
  if (j < 0) return null;

  let sortOrder = j;
  if (oldParent === newParentValue) {
    const i = siblingIndex(prevItems, activeId);
    if (i < 0) return null;
    if (j === i || j === i + 1) return null;
    sortOrder = j > i ? j - 1 : j;
  }

  const updatedActiveItem = {
    ...activeItem,
    parentValue: newParentValue,
  };

  const nextItems = insertSubtreeAt(
    itemsWithoutActiveTree,
    referenceIndex,
    updatedActiveItem,
    activeItemDescendants,
  );

  return {
    items: nextItems,
    parentId:
      newParentValue === undefined ? null : String(newParentValue),
    sortOrder,
    openParentId: newParentValue,
  };
};

export const buildSiblingReorderMove = (
  prevItems: FlatMoveItem[],
  id: string,
  direction: "up" | "down",
): SiblingReorderResult | null => {
  const currentIndex = prevItems.findIndex((item) => item.value === id);
  if (currentIndex === -1) return null;

  const currentItem = prevItems[currentIndex];
  const siblings = prevItems.filter(
    (item) => item.parentValue === currentItem.parentValue,
  );
  const siblingIndexValue = siblings.findIndex((item) => item.value === id);

  let targetSiblingIndex = -1;
  if (direction === "up" && siblingIndexValue > 0) {
    targetSiblingIndex = siblingIndexValue - 1;
  } else if (direction === "down" && siblingIndexValue < siblings.length - 1) {
    targetSiblingIndex = siblingIndexValue + 1;
  }
  if (targetSiblingIndex === -1) return null;

  const targetSiblingValue = siblings[targetSiblingIndex].value;
  const newSortOrder = targetSiblingIndex;

  const nodeDescendants = getAllDescendants(id, prevItems);
  const descendantIds = new Set(
    Array.from(nodeDescendants.keys()) as UniqueIdentifier[],
  );

  const itemsToMove = prevItems.filter(
    (item) =>
      item.value === id || descendantIds.has(item.value as UniqueIdentifier),
  );

  const newItems = prevItems.filter(
    (item) =>
      item.value !== id && !descendantIds.has(item.value as UniqueIdentifier),
  );

  const targetIdxInNew = newItems.findIndex(
    (item) => item.value === targetSiblingValue,
  );
  if (targetIdxInNew === -1) return null;

  const targetDescendants = getAllDescendants(targetSiblingValue, newItems);
  const targetSubtreeLen = 1 + targetDescendants.size;
  const insertionIndex =
    direction === "up" ? targetIdxInNew : targetIdxInNew + targetSubtreeLen;

  newItems.splice(insertionIndex, 0, ...itemsToMove);

  return {
    items: newItems,
    parentId:
      currentItem.parentValue === undefined
        ? null
        : String(currentItem.parentValue),
    sortOrder: newSortOrder,
  };
};
