export const MAX_TREE_LEVEL = 20;

export const DEPTH_LIMIT_ADD_MESSAGE = `Notes can be nested up to ${MAX_TREE_LEVEL} levels. This note is already at the limit, so a child cannot be added here.`;

export const DEPTH_LIMIT_MOVE_MESSAGE = `Notes can be nested up to ${MAX_TREE_LEVEL} levels. Moving this branch here would nest it too deeply.`;

export type TreeParentLink = {
  value: string | number;
  parentValue?: string | number;
};

export function nodeLevel(
  items: TreeParentLink[],
  id: string | number,
): number {
  const itemMap = new Map(items.map((item) => [String(item.value), item]));
  let level = 0;
  let cursor: string | undefined = String(id);
  const seen = new Set<string>();

  while (cursor !== undefined) {
    if (seen.has(cursor)) return level;
    seen.add(cursor);
    const item = itemMap.get(cursor);
    if (!item) break;
    level += 1;
    cursor =
      item.parentValue === undefined ? undefined : String(item.parentValue);
  }

  return level;
}

export function subtreeDepth(
  items: TreeParentLink[],
  id: string | number,
): number {
  const childrenByParent = new Map<string, string[]>();
  for (const item of items) {
    if (item.parentValue === undefined) continue;
    const parentKey = String(item.parentValue);
    const children = childrenByParent.get(parentKey);
    const childId = String(item.value);
    if (children) children.push(childId);
    else childrenByParent.set(parentKey, [childId]);
  }

  const depthOf = (nodeId: string, visiting: Set<string>): number => {
    if (visiting.has(nodeId)) return 1;
    visiting.add(nodeId);
    const children = childrenByParent.get(nodeId) ?? [];
    if (children.length === 0) return 1;
    return 1 + Math.max(...children.map((child) => depthOf(child, visiting)));
  };

  return depthOf(String(id), new Set());
}

export function resultingMaxLevel(
  parentLevel: number,
  draggedSubtreeDepth: number,
): number {
  return parentLevel + draggedSubtreeDepth;
}

export function wouldExceedMaxLevel(
  items: TreeParentLink[],
  nodeId: string | number,
  newParentId: string | number | null | undefined,
): boolean {
  const parentLevel =
    newParentId === null || newParentId === undefined
      ? 0
      : nodeLevel(items, newParentId);
  const depth = subtreeDepth(items, nodeId);
  const resulting = resultingMaxLevel(parentLevel, depth);
  if (resulting <= MAX_TREE_LEVEL) return false;
  const currentMax = nodeLevel(items, nodeId) + depth - 1;
  return resulting > currentMax;
}

export function canAddChildAtLevel(level: number): boolean {
  return level > 0 && level < MAX_TREE_LEVEL;
}
