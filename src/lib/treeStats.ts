import type { UniqueIdentifier } from "@dnd-kit/core";

export type TreeStatsItem = {
  value: UniqueIdentifier;
  parentValue?: UniqueIdentifier;
};

export function countDescendants(
  items: TreeStatsItem[],
  nodeId: UniqueIdentifier,
): number {
  const childrenByParent = new Map<
    UniqueIdentifier | undefined,
    UniqueIdentifier[]
  >();

  for (const item of items) {
    const parent = item.parentValue;
    const siblings = childrenByParent.get(parent);
    if (siblings) {
      siblings.push(item.value);
    } else {
      childrenByParent.set(parent, [item.value]);
    }
  }

  if (!items.some((item) => item.value === nodeId)) {
    return 0;
  }

  let count = 0;
  const stack: UniqueIdentifier[] = [...(childrenByParent.get(nodeId) ?? [])];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    const key = String(current);
    if (visited.has(key)) continue;
    visited.add(key);
    count += 1;
    const children = childrenByParent.get(current);
    if (children) {
      for (const child of children) {
        stack.push(child);
      }
    }
  }

  return count;
}

export function formatSubtreeStats(count: number, isRoot: boolean): string {
  if (count === 0) {
    return "No child notes";
  }
  const scope = isRoot ? "tree" : "branch";
  const noun = count === 1 ? "note" : "notes";
  return `${count} ${noun} in this ${scope}`;
}
