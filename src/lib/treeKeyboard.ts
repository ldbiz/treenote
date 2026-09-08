export type TreeKeyboardItemMeta = {
  parentId: string | null;
  hasChildren: boolean;
  isOpen: boolean;
};

export type TreeKeyboardAction =
  | { type: "select"; id: string }
  | { type: "toggleOpen"; id: string }
  | { type: "delete"; id: string }
  | { type: "activate" }
  | { type: "leave"; direction: "forward" | "backward" }
  | { type: "suppress" };

export type TreeKeyboardInput = {
  visibleIds: string[];
  itemMeta: Map<string, TreeKeyboardItemMeta>;
  currentId: string | null;
  pageSize: number;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

export function computeTreePageSize(
  scrollerHeight: number,
  rowHeight: number,
): number {
  if (scrollerHeight <= 0 || rowHeight <= 0) return 1;
  return Math.max(1, Math.floor(scrollerHeight / rowHeight) - 1);
}

function firstVisibleChild(
  visibleIds: string[],
  itemMeta: Map<string, TreeKeyboardItemMeta>,
  parentId: string,
  currentIndex: number,
): string | null {
  for (let i = currentIndex + 1; i < visibleIds.length; i += 1) {
    const id = visibleIds[i];
    if (itemMeta.get(id)?.parentId === parentId) return id;
  }
  return null;
}

function selectAt(
  visibleIds: string[],
  index: number,
): TreeKeyboardAction | null {
  if (visibleIds.length === 0) return null;
  const clamped = Math.max(0, Math.min(index, visibleIds.length - 1));
  return { type: "select", id: visibleIds[clamped] };
}

export function resolveTreeKeyboardAction(
  input: TreeKeyboardInput,
): TreeKeyboardAction | null {
  const {
    visibleIds,
    itemMeta,
    currentId,
    pageSize,
    key,
    ctrlKey,
    altKey,
    metaKey,
    shiftKey,
  } = input;

  if (ctrlKey || altKey || metaKey) return null;

  if (key === "Tab") {
    return { type: "leave", direction: shiftKey ? "backward" : "forward" };
  }
  if (key === " ") {
    return { type: "suppress" };
  }

  const currentIndex = currentId ? visibleIds.indexOf(currentId) : -1;
  const hasCurrentInList = currentIndex >= 0;

  if (!hasCurrentInList) {
    if (visibleIds.length === 0) return null;
    switch (key) {
      case "ArrowDown":
      case "Home":
      case "PageDown":
        return { type: "select", id: visibleIds[0] };
      case "ArrowUp":
      case "End":
      case "PageUp":
        return { type: "select", id: visibleIds[visibleIds.length - 1] };
      case "Delete":
        return currentId ? { type: "delete", id: currentId } : null;
      case "Enter":
        return currentId ? { type: "activate" } : null;
      default:
        return null;
    }
  }

  const meta = itemMeta.get(currentId!);

  switch (key) {
    case "ArrowDown":
      return selectAt(visibleIds, currentIndex + 1);
    case "ArrowUp":
      return selectAt(visibleIds, currentIndex - 1);
    case "Home":
      return { type: "select", id: visibleIds[0] };
    case "End":
      return { type: "select", id: visibleIds[visibleIds.length - 1] };
    case "PageDown":
      return selectAt(visibleIds, currentIndex + Math.max(1, pageSize));
    case "PageUp":
      return selectAt(visibleIds, currentIndex - Math.max(1, pageSize));
    case "ArrowLeft": {
      if (!meta) return null;
      if (meta.hasChildren && meta.isOpen) {
        return { type: "toggleOpen", id: currentId! };
      }
      if (meta.parentId && visibleIds.includes(meta.parentId)) {
        return { type: "select", id: meta.parentId };
      }
      return null;
    }
    case "ArrowRight": {
      if (!meta) return null;
      if (meta.hasChildren && !meta.isOpen) {
        return { type: "toggleOpen", id: currentId! };
      }
      const childId = firstVisibleChild(
        visibleIds,
        itemMeta,
        currentId!,
        currentIndex,
      );
      return childId ? { type: "select", id: childId } : null;
    }
    case "Delete":
      return { type: "delete", id: currentId! };
    case "Enter":
      return { type: "activate" };
    default:
      return null;
  }
}
