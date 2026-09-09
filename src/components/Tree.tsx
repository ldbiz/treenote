import React, {
  useState,
  forwardRef,
  useImperativeHandle,
  useCallback,
  useRef,
  useEffect,
  useMemo,
} from "react";
import {
  FlatTree,
  FlatTreeItem,
  TreeItemLayout,
  useHeadlessFlatTree_unstable,
  HeadlessFlatTreeItemProps,
  FlatTreeItemProps,
  Input,
  useRestoreFocusTarget,
} from "@fluentui/react-components";
import {
  DndContext,
  PointerSensor,
  UniqueIdentifier,
  closestCenter,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  DragEndEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  getInitialTree,
  TreeNodeData,
  addNode,
  formatDefaultNodeTitle,
  updateNode,
  moveNode,
  duplicateNode,
} from "../lib/tree";
import { showMessage } from "../lib/dialogs";
import NodeContextMenu, {
  type NodeContextMenuAction,
} from "./NodeContextMenu";
import { isContextMenuKey } from "./popupMenu";
import {
  computeTreePageSize,
  resolveTreeKeyboardAction,
  type TreeKeyboardItemMeta,
} from "../lib/treeKeyboard";
import { cancelTreeFocus, focusTreeNode } from "../lib/treeFocus";
import {
  DEPTH_LIMIT_ADD_MESSAGE,
  DEPTH_LIMIT_MOVE_MESSAGE,
  canAddChildAtLevel,
  nodeLevel,
  wouldExceedMaxLevel,
} from "../lib/treeDepth";

// --- Data Structures ---

// Original nested data structure for tree nodes
type OriginalTreeNodeData = TreeNodeData;

// Flat data structure required by Fluent UI FlatTree
// 'layout' is the display label, 'isDraggable' controls drag behavior
// Inherits value/parentValue from HeadlessFlatTreeItemProps
//
type FlatItem = HeadlessFlatTreeItemProps & {
  layout: string;
  isDraggable?: boolean;
  isDirectMatch?: boolean; // Flag for direct text match
};

// Recursively convert nested tree data to flat array for FlatTree
const convertToFlatData = (
  nodes: OriginalTreeNodeData[],
  parentValue: UniqueIdentifier | null = null,
  initialOpen: Set<UniqueIdentifier>,
  initialFlatData: FlatItem[] = []
): FlatItem[] => {
  nodes.forEach((node) => {
    const flatNode: FlatItem = {
      value: node.id,
      parentValue: parentValue ?? undefined, // undefined for root
      layout: node.label,
      isDraggable: true, // All nodes are draggable by default
      isDirectMatch: false, // Initialize
    };
    initialFlatData.push(flatNode);
    if (node.isExpanded) {
      initialOpen.add(node.id);
    }
    if (node.children) {
      convertToFlatData(node.children, node.id, initialOpen, initialFlatData);
    }
  });
  return initialFlatData;
};

// Function to find a node and update its label in the flat list
const updateNodeLabelInFlatList = (
  items: FlatItem[],
  nodeId: string,
  newLabel: string
): FlatItem[] => {
  return items.map((item) => {
    if (item.value === nodeId) {
      // Preserve other flags like isDirectMatch if necessary, though they get recalculated on filter
      return { ...item, layout: newLabel };
    }
    return item;
  });
};

// Helper to collect all node IDs from nested tree data
function collectAllNodeIds(nodes: OriginalTreeNodeData[]): string[] {
  let ids: string[] = [];
  for (const node of nodes) {
    ids.push(node.id);
    if (node.children) {
      ids = ids.concat(collectAllNodeIds(node.children));
    }
  }
  return ids;
}

// --- Hierarchy guide lines ---

// Per-row metadata used to draw the "L" connector lines that link a parent
// to each of its children. `ancestorLast[k]` tells whether the ancestor at
// level (k + 1) is the last child of its own parent, which decides whether a
// continuous vertical line should pass through this row at that indent column.
type GuideInfo = {
  level: number;
  isLast: boolean;
  ancestorLast: boolean[];
};

// Compute guide metadata for the currently visible rows (in display order).
// Sibling / "last child" relationships are derived from what is actually
// visible so collapsed or filtered branches don't leave dangling lines.
const buildGuideMap = (
  visibleValues: { value: UniqueIdentifier; level: number }[],
  itemMap: Map<UniqueIdentifier, FlatItem>
): Map<UniqueIdentifier, GuideInfo> => {
  const parentKeyOf = (value: UniqueIdentifier): string => {
    const parentValue = itemMap.get(value)?.parentValue;
    return parentValue === undefined ? "__root__" : String(parentValue);
  };

  // Last visible row for each parent = last sibling (rows come in DFS order).
  const lastChildByParent = new Map<string, UniqueIdentifier>();
  visibleValues.forEach(({ value }) => {
    lastChildByParent.set(parentKeyOf(value), value);
  });
  const isLastOf = (value: UniqueIdentifier): boolean =>
    lastChildByParent.get(parentKeyOf(value)) === value;

  const guideMap = new Map<UniqueIdentifier, GuideInfo>();
  visibleValues.forEach(({ value, level }) => {
    const ancestorsTopDown: UniqueIdentifier[] = [];
    let cursor = itemMap.get(value)?.parentValue;
    while (cursor !== undefined) {
      ancestorsTopDown.unshift(cursor);
      cursor = itemMap.get(cursor)?.parentValue;
    }
    guideMap.set(value, {
      level,
      isLast: isLastOf(value),
      ancestorLast: ancestorsTopDown.map((ancestor) => isLastOf(ancestor)),
    });
  });
  return guideMap;
};

// --- Components ---

const EXPAND_ICON_SELECTOR = ".fui-TreeItemLayout__expandIcon";

const isExpandIconTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && !!target.closest(EXPAND_ICON_SELECTOR);

// Tree item that supports selection and drag-and-drop
const SelectableDraggableFlatTreeItem = ({
  children,
  value,
  layout,
  selectedNodeId,
  onNodeSelect,
  onRename,
  onToggleOpen,
  hasChildren,
  isDraggableProp, // Controls drag/drop for this item
  isDirectMatchForFilter, // New: Is this a direct match WHEN filtering is active?
  isFilterModeActive, // New: Is the tree filter UI active AND has found matches?
  isTreeCurrentlyFiltered, // New: Is the tree visually filtering nodes?
  allNodesWithSearchMatches, // New: All nodes with matches, regardless of filtering
  searchQuery, // Add searchQuery prop for label highlighting
  suppressClickAfterDragRef,
  guide, // Hierarchy guide-line metadata for this row
  onNodeContextMenu,
  renameRequestId,
  onRenameRequestHandled,
  ...rest
}: FlatTreeItemProps & {
  layout: string;
  selectedNodeId: string | null;
  onNodeSelect: (id: string) => void;
  onRename: (id: string, newLabel: string) => void;
  onToggleOpen: () => void;
  hasChildren: boolean;
  isDraggableProp: boolean;
  suppressClickAfterDragRef: React.MutableRefObject<boolean>;
  guide?: GuideInfo;
  onNodeContextMenu?: (id: string, position: { x: number; y: number }) => void;
  renameRequestId?: string | null;
  onRenameRequestHandled?: () => void;
  isDirectMatchForFilter?: boolean; // New: Is this a direct match WHEN filtering is active?
  isFilterModeActive?: boolean; // New: Is the tree filter UI active AND has found matches?
  isTreeCurrentlyFiltered?: boolean; // New: Is the tree visually filtering nodes?
  allNodesWithSearchMatches: Set<string> | null; // Changed from optional to required: Set<string> | null
  searchQuery?: string; // Add searchQuery prop for label highlighting
  reloadKey?: number;
}) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(layout);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const longPressTimer = useRef<number | null>(null);
  const hasMoved = useRef(false);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const suppressNextClickRef = useRef(false);
  const restoreFocusTargetAttribute = useRestoreFocusTarget();

  // Setup drag and drop hooks
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableNodeRef,
    transform,
    isDragging,
  } = useDraggable({
    id: value as UniqueIdentifier,
    disabled: !isDraggableProp || isRenaming,
  });
  const { setNodeRef: setDroppableNodeRef } = useDroppable({
    id: value as UniqueIdentifier,
    disabled: false, // Always allow dropping on all nodes
  });

  // Combine drag and drop refs
  const setNodeRef = (node: HTMLElement | null) => {
    setDraggableNodeRef(node);
    setDroppableNodeRef(node);
  };

  // --- Rename Logic ---

  // Clear the long press timer
  const clearLongPressTimer = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // Handle mouse down: start timer for long press
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (e.button !== 0 || isRenaming || isExpandIconTarget(e.target)) return;

      clearLongPressTimer();
      hasMoved.current = false;
      startPos.current = { x: e.clientX, y: e.clientY };

      longPressTimer.current = setTimeout(() => {
        if (!hasMoved.current) {
          suppressNextClickRef.current = true;
          setIsRenaming(true);
          setRenameValue(layout);
          e.stopPropagation();
          e.preventDefault();
        }
        longPressTimer.current = null;
        startPos.current = null;
      }, 500);
    },
    [clearLongPressTimer, isRenaming, layout]
  );

  // Handle mouse move: clear timer if moved significantly
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (longPressTimer.current && startPos.current) {
        const dx = Math.abs(e.clientX - startPos.current.x);
        const dy = Math.abs(e.clientY - startPos.current.y);
        if (dx > 5 || dy > 5) {
          hasMoved.current = true;
          clearLongPressTimer();
          startPos.current = null;
        }
      }
    },
    [clearLongPressTimer]
  );

  // Handle mouse up: clear timer
  const handleMouseUp = useCallback(() => {
    clearLongPressTimer();
    startPos.current = null;
  }, [clearLongPressTimer]);

  // Handle rename input changes
  const handleRenameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setRenameValue(e.target.value);
  };

  // Finish renaming (on blur or Enter)
  const finishRename = useCallback(() => {
    if (!isRenaming) return;
    clearLongPressTimer();
    const trimmedValue = renameValue.trim();
    if (trimmedValue && trimmedValue !== layout) {
      onRename(value as string, trimmedValue);
    }
    setIsRenaming(false);
    focusTreeNode(value as string);
  }, [isRenaming, renameValue, layout, onRename, value, clearLongPressTimer]);

  // Cancel renaming (on Escape)
  const cancelRename = useCallback(() => {
    if (!isRenaming) return;
    setIsRenaming(false);
    setRenameValue(layout);
    focusTreeNode(value as string);
  }, [isRenaming, layout, value]);

  // Handle key presses in the input
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finishRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  };

  // Focus and select text when rename mode starts
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  useEffect(() => {
    if (renameRequestId === value && !isRenaming) {
      setIsRenaming(true);
      setRenameValue(layout);
      onRenameRequestHandled?.();
    }
  }, [renameRequestId, value, isRenaming, layout, onRenameRequestHandled]);

  // Don't enter rename mode while a drag is in progress
  useEffect(() => {
    if (isDragging) {
      clearLongPressTimer();
      if (isRenaming) {
        setIsRenaming(false);
      }
    }
  }, [isDragging, clearLongPressTimer, isRenaming]);

  // --- Styling and Rendering ---

  // Fluent only pre-generates indent classes for levels 1–10. Levels 11+
  // need --fluent-TreeItem--level on the row. Set it here as a unitless
  // string so our drag `style` cannot replace Fluent's fallback.
  const indentLevel =
    typeof rest["aria-level"] === "number" && rest["aria-level"] >= 1
      ? rest["aria-level"]
      : 1;

  const style = {
    transform: CSS.Transform.toString(transform),
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 1 : 0,
    position: "relative",
    cursor: isRenaming ? "default" : isDragging ? "grabbing" : "default",
    touchAction: "none",
    ["--fluent-TreeItem--level"]: String(indentLevel),
  } as React.CSSProperties;

  const isActuallySelected = value === selectedNodeId;

  const filteredDragListeners = useMemo(() => {
    if (!isDraggableProp || isRenaming || !listeners) return {};
    const filtered: Record<string, unknown> = {};
    for (const [eventName, handler] of Object.entries(listeners)) {
      if (eventName === "onKeyDown" || eventName === "onKeyUp") continue;
      filtered[eventName] = (event: Event) => {
        if (isExpandIconTarget(event.target)) return;
        if (typeof handler === "function") {
          handler(event);
        }
      };
    }
    return filtered;
  }, [isDraggableProp, isRenaming, listeners]);

  // Updated text color logic
  let itemTextColor = "var(--text-muted)"; // Default: muted grey for unselected
  const currentItemId = String(value);

  if (isTreeCurrentlyFiltered) {
    // Tree IS being visually filtered
    // isFilterModeActive is true if the filter is on AND focusNodeIds (direct matches) are present.
    // isDirectMatchForFilter is true if this item is one of those direct matches.
    if (isFilterModeActive && !isDirectMatchForFilter) {
      itemTextColor = "var(--text-dimmed)"; // Grey out ancestor nodes
    }
  } else {
    // Tree is NOT being visually filtered, but a search might be active
    if (allNodesWithSearchMatches && allNodesWithSearchMatches.size > 0) {
      // A global search is active
      if (!allNodesWithSearchMatches.has(currentItemId)) {
        itemTextColor = "var(--text-dimmed)"; // Grey out if this node does not have a match
      }
    }
  }

  // Helper to highlight search matches in label
  function highlightLabel(label: string, searchQuery?: string) {
    if (!searchQuery || !searchQuery.trim()) return label;
    const query = searchQuery.trim();
    const regex = new RegExp(
      query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "gi"
    );
    const parts = [];
    let lastIndex = 0;
    let match;
    let idx = 0;
    while ((match = regex.exec(label)) !== null) {
      if (match.index > lastIndex) {
        parts.push(label.slice(lastIndex, match.index));
      }
      parts.push(
        <span key={"match-" + idx} className="search-match">
          {match[0]}
        </span>
      );
      lastIndex = regex.lastIndex;
      idx++;
    }
    if (lastIndex < label.length) {
      parts.push(label.slice(lastIndex));
    }
    return parts.length > 0 ? parts : label;
  }

  // Draw the "L" shaped connector lines linking this row to its parent, plus
  // the continuous vertical lines for any ancestors that still have siblings
  // below. Column X positions mirror Fluent's per-level indentation.
  const renderGuides = () => {
    if (!guide || guide.level < 2) return null;

    const level = guide.level;
    const segments: React.ReactNode[] = [];
    const gap = "var(--tree-guide-gap, 2px)";

    for (let columnLevel = 1; columnLevel <= level - 1; columnLevel++) {
      // Align under the centre of the parent's expand chevron.
      // Indent must match Fluent's spacingHorizontalXXL (24px), not 20px.
      const x = `calc(var(--tree-guide-base) + ${
        columnLevel - 1
      } * var(--tree-guide-indent))`;
      const isConnectorColumn = columnLevel === level - 1;

      if (isConnectorColumn) {
        if (guide.isLast) {
          // Rounded └ corner under the parent's expand chevron.
          segments.push(
            <span
              key={`corner-${columnLevel}`}
              className="tree-guide-corner"
              style={{
                left: x,
                top: `calc(-1 * ${gap})`,
                width: "var(--tree-guide-tick)",
                height: `calc(50% + ${gap})`,
              }}
            />
          );
        } else {
          // ├ : full-height vertical plus a short arm at mid-height.
          segments.push(
            <span
              key={`v-${columnLevel}`}
              className="tree-guide-v"
              style={{
                left: x,
                top: `calc(-1 * ${gap})`,
                height: `calc(100% + ${gap})`,
              }}
            />
          );
          segments.push(
            <span
              key={`h-${columnLevel}`}
              className="tree-guide-h"
              style={{
                left: x,
                top: "50%",
                width: "var(--tree-guide-tick)",
                transform: "translateY(-50%)",
              }}
            />
          );
        }
      } else if (!guide.ancestorLast[columnLevel]) {
        // The ancestor whose children this column connects still has siblings
        // below, so draw a continuous vertical through this descendant row.
        // Index is `columnLevel` (not columnLevel-1): column k belongs to the
        // children of the level-k node, so we care whether the level-(k+1)
        // ancestor is last among those children.
        segments.push(
          <span
            key={`c-${columnLevel}`}
            className="tree-guide-v"
            style={{
              left: x,
              top: `calc(-1 * ${gap})`,
              height: `calc(100% + ${gap})`,
            }}
          />
        );
      }
    }

    return (
      <span className="tree-guides" aria-hidden="true">
        {segments}
      </span>
    );
  };

  return (
    <FlatTreeItem
      ref={setNodeRef}
      value={value}
      data-app-context-menu=""
      {...(isDraggableProp && !isRenaming ? attributes : {})}
      {...(isDraggableProp && !isRenaming ? filteredDragListeners : {})}
      {...rest}
      style={style}
      {...restoreFocusTargetAttribute}
      aria-selected={isActuallySelected}
      onFocus={(e) => {
        rest.onFocus?.(e);
        if (!isRenaming) {
          onNodeSelect(value as string);
        }
      }}
      onKeyDown={(e) => {
        rest.onKeyDown?.(e);
        if (e.defaultPrevented || isRenaming) return;
        if (e.key === "F2") {
          e.preventDefault();
          e.stopPropagation();
          setIsRenaming(true);
          setRenameValue(layout);
          return;
        }
        if (isContextMenuKey(e)) {
          e.preventDefault();
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          onNodeContextMenu?.(value as string, {
            x: rect.left,
            y: rect.bottom,
          });
        }
      }}
    >
      {renderGuides()}
      <TreeItemLayout
        className={hasChildren ? "tree-item-branch" : undefined}
        style={{
          boxShadow: isActuallySelected && !isRenaming
            ? "inset 2px 0 0 var(--accent)"
            : undefined,
          backgroundColor: isActuallySelected && !isRenaming ? "var(--accent-bg)" : undefined,
          fontWeight: isActuallySelected && !isRenaming ? 500 : undefined,
          userSelect: isRenaming ? "text" : "none",
          WebkitUserSelect: isRenaming ? "text" : "none",
          msUserSelect: isRenaming ? "text" : "none",
          color: isActuallySelected && !isRenaming ? "var(--text)" : itemTextColor,
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onContextMenu={(e) => {
          if (isRenaming || isExpandIconTarget(e.target)) return;
          e.preventDefault();
          e.stopPropagation();
          onNodeContextMenu?.(value as string, {
            x: e.clientX,
            y: e.clientY,
          });
        }}
        onClick={(e) => {
          if (suppressClickAfterDragRef.current || transform || isRenaming) {
            if (isRenaming) e.stopPropagation();
            return;
          }

          if (suppressNextClickRef.current) {
            suppressNextClickRef.current = false;
            e.stopPropagation();
            return;
          }

          const target = e.target as HTMLElement;
          if (isExpandIconTarget(target) || target.closest("input")) {
            return;
          }

          onNodeSelect(value as string);
          if (hasChildren) {
            onToggleOpen();
          }
          focusTreeNode(value as string);
          e.stopPropagation();
        }}
        draggable={false}
      >
        {isRenaming ? (
          <Input
            ref={renameInputRef}
            value={renameValue}
            onChange={handleRenameChange}
            onBlur={finishRename}
            onKeyDown={handleKeyDown}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            style={{
              width: "100%",
              height: "auto",
              padding: "0 2px",
              margin: "0",
              boxSizing: "border-box",
            }}
            aria-label={`Rename ${layout}`}
          />
        ) : (
          highlightLabel(layout, searchQuery)
        )}
      </TreeItemLayout>
    </FlatTreeItem>
  );
};

// --- Main Tree Component ---

interface TreeComponentProps {
  selectedNodeId: string | null;
  onNodeSelect: (id: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onActivateNode?: () => void;
  onExportNode: (nodeId: string) => Promise<void>;
  focusNodeIds: Set<string> | null; // These are the direct matches when filtering is on
  isTreeCurrentlyFiltered: boolean; // New: Is the tree visually filtering nodes?
  allNodesWithSearchMatches: Set<string> | null; // New: All nodes with matches, regardless of filtering
  searchQuery?: string; // Add searchQuery prop for label highlighting
  reloadKey?: number;
  onCanAddChildChange?: (canAddChild: boolean) => void;
}

interface TreeComponentHandle {
  moveNodeUp: (id: string) => void;
  moveNodeDown: (id: string) => void;
  insertRootAfterSelected: (id: string | null) => void;
  insertChildFirst: (id: string) => void;
  hasChildren: (id: string) => boolean;
  getParentId: (id: string) => string | null;
  getNextSiblingId: (id: string) => string | null;
  getPreviousSiblingId: (id: string) => string | null;
  removeItemAndDescendants: (id: string) => void;
  ensureNodeIsOpen: (id: string) => void;
  getAllNodeIdsInOrder: () => string[];
  scrollNodeIntoView: (id: string) => void;
  focusNode: (id: string) => void;
  getAllNodeIdsRecursive: () => string[];
}

// Returns true if itemId is a descendant of parentId in the flat list
const isDescendant = (
  itemId: UniqueIdentifier,
  parentId: UniqueIdentifier,
  items: FlatItem[]
): boolean => {
  const itemMap = new Map(items.map((i) => [i.value, i]));
  let current = itemMap.get(itemId);
  while (current?.parentValue) {
    if (current.parentValue === parentId) {
      return true;
    }
    current = itemMap.get(current.parentValue);
  }
  return false;
};

// Gets all descendants of a node by its ID
const getAllDescendants = (
  nodeId: UniqueIdentifier,
  items: FlatItem[]
): Map<UniqueIdentifier, FlatItem> => {
  const descendants = new Map<UniqueIdentifier, FlatItem>();

  // Start with direct children
  const directChildren = items.filter((item) => item.parentValue === nodeId);

  // Add each child and recursively find their descendants
  directChildren.forEach((child) => {
    descendants.set(child.value, child);
    const childDescendants = getAllDescendants(child.value, items);
    childDescendants.forEach((descendant, id) => {
      descendants.set(id, descendant);
    });
  });

  return descendants;
};

// Count existing siblings under a parent (undefined parentValue = root level)
const countSiblings = (
  items: FlatItem[],
  parentValue: UniqueIdentifier | undefined
): number => {
  return items.filter((item) => item.parentValue === parentValue).length;
};

type ReparentMoveResult = {
  items: FlatItem[];
  sortOrder: number;
  openParentId?: UniqueIdentifier;
};

const buildReparentMove = (
  prevItems: FlatItem[],
  activeId: UniqueIdentifier,
  newParentValue: UniqueIdentifier | undefined
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
      !activeItemDescendants.has(item.value as UniqueIdentifier)
  );

  const updatedActiveItem = {
    ...activeItem,
    parentValue: newParentValue,
  };

  let nextItems: FlatItem[];
  let openParentId: UniqueIdentifier | undefined;

  if (newParentValue === undefined) {
    nextItems = [
      ...itemsWithoutActiveTree,
      updatedActiveItem,
      ...Array.from(activeItemDescendants).map(([_, item]) => item),
    ];
  } else {
    const overIndex = itemsWithoutActiveTree.findIndex(
      (item) => item.value === newParentValue
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

    nextItems = [
      ...itemsWithoutActiveTree.slice(0, insertionIndex),
      updatedActiveItem,
      ...Array.from(activeItemDescendants).map(([_, item]) => item),
      ...itemsWithoutActiveTree.slice(insertionIndex),
    ];
    openParentId = newParentValue;
  }

  return {
    items: nextItems,
    sortOrder: countSiblings(itemsWithoutActiveTree, newParentValue),
    openParentId,
  };
};

type SiblingReorderResult = {
  items: FlatItem[];
  parentId: string | null;
  sortOrder: number;
};

// Reorders a node among its siblings (including root-level nodes)
const buildSiblingReorderMove = (
  prevItems: FlatItem[],
  id: string,
  direction: "up" | "down"
): SiblingReorderResult | null => {
  const currentIndex = prevItems.findIndex((item) => item.value === id);
  if (currentIndex === -1) return null;

  const currentItem = prevItems[currentIndex];

  const siblings = prevItems.filter(
    (item) => item.parentValue === currentItem.parentValue
  );
  const siblingIndex = siblings.findIndex((item) => item.value === id);

  let targetSiblingIndex = -1;
  if (direction === "up" && siblingIndex > 0) {
    targetSiblingIndex = siblingIndex - 1;
  } else if (direction === "down" && siblingIndex < siblings.length - 1) {
    targetSiblingIndex = siblingIndex + 1;
  }

  if (targetSiblingIndex === -1) return null;

  const targetSiblingValue = siblings[targetSiblingIndex].value;
  const newSortOrder = targetSiblingIndex;

  const nodeDescendants = getAllDescendants(id, prevItems);
  const descendantIds = new Set(
    Array.from(nodeDescendants.keys()) as UniqueIdentifier[]
  );

  const itemsToMove = prevItems.filter(
    (item) =>
      item.value === id || descendantIds.has(item.value as UniqueIdentifier)
  );

  const newItems = prevItems.filter(
    (item) =>
      item.value !== id && !descendantIds.has(item.value as UniqueIdentifier)
  );

  const targetIdxInNew = newItems.findIndex(
    (item) => item.value === targetSiblingValue
  );
  if (targetIdxInNew === -1) return null;

  const targetDescendants = getAllDescendants(
    targetSiblingValue,
    newItems
  );
  const targetSubtreeLen = 1 + targetDescendants.size;

  const insertionIndex =
    direction === "up"
      ? targetIdxInNew
      : targetIdxInNew + targetSubtreeLen;

  newItems.splice(insertionIndex, 0, ...itemsToMove);

  const parentValue = currentItem.parentValue;

  return {
    items: newItems,
    parentId:
      parentValue === undefined ? null : String(parentValue),
    sortOrder: newSortOrder,
  };
};

// Helper function to find the ultimate root ancestor of a node
const findRootAncestor = (
  itemId: UniqueIdentifier,
  items: FlatItem[]
): FlatItem | undefined => {
  const itemMap = new Map(items.map((i) => [i.value, i]));
  let current = itemMap.get(itemId);
  while (current?.parentValue) {
    const parent = itemMap.get(current.parentValue);
    if (!parent) {
      // Should not happen in a consistent tree, but handle defensively
      return undefined;
    }
    current = parent; // Move up to the parent
  }
  // When parentValue is undefined, 'current' is the root ancestor
  return current;
};

// Create a wrapper that acts as a drop area for the entire component
const DropArea = ({
  children,
  id,
}: {
  children: React.ReactNode;
  id: string;
}) => {
  const { setNodeRef } = useDroppable({
    id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        height: "100%",
        width: "100%",
        position: "relative",
        minHeight: "300px", // Ensure there's space to drop
      }}
    >
      {children}
    </div>
  );
};

// Main tree component: manages state, drag-and-drop, and selection
const TreeComponent = forwardRef<TreeComponentHandle, TreeComponentProps>(
  (
    {
      selectedNodeId,
      onNodeSelect,
      onDeleteNode,
      onActivateNode,
      onExportNode,
      focusNodeIds, // Direct matches for filtering
      isTreeCurrentlyFiltered, // Is the tree visually filtered?
      allNodesWithSearchMatches, // All nodes that have a match (for greying when not filtering)
      searchQuery, // Add searchQuery prop for label highlighting
      reloadKey,
      onCanAddChildChange,
    },
    ref
  ) => {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [items, setItems] = useState<FlatItem[]>([]);
    const [openItems, setOpenItems] = useState<Set<UniqueIdentifier>>(
      new Set()
    );
    const initialOpen = useRef(new Set<UniqueIdentifier>()).current; // Store initial open state
    const [treeData, setTreeData] = useState<OriginalTreeNodeData[]>([]); // Store original tree
    const suppressClickAfterDragRef = useRef(false);
    const [contextMenu, setContextMenu] = useState<{
      nodeId: string;
      x: number;
      y: number;
    } | null>(null);
    const [renameRequestId, setRenameRequestId] = useState<string | null>(null);
    const treeScrollerRef = useRef<HTMLDivElement>(null);

    const reloadTreeFromBackend = useCallback(
      async (preserveOpenItems: Set<UniqueIdentifier>) => {
        const freshTreeData = await getInitialTree();
        setTreeData(freshTreeData);
        const reopenSet = new Set(preserveOpenItems);
        const flatItems = convertToFlatData(freshTreeData, null, reopenSet);
        setItems(flatItems);
        setOpenItems(new Set(reopenSet));
      },
      []
    );

    const itemMap = useMemo(() => {
      const map = new Map<UniqueIdentifier, FlatItem>();
      items.forEach((item) => map.set(item.value, item));
      return map;
    }, [items]);

    const parentIds = useMemo(() => {
      const ids = new Set<UniqueIdentifier>();
      items.forEach((item) => {
        if (item.parentValue !== undefined) {
          ids.add(item.parentValue);
        }
      });
      return ids;
    }, [items]);

    const toggleNodeOpen = useCallback((id: UniqueIdentifier) => {
      setOpenItems((prevOpen) => {
        const nextOpen = new Set(prevOpen);
        if (nextOpen.has(id)) {
          nextOpen.delete(id);
        } else {
          nextOpen.add(id);
        }
        return nextOpen;
      });
    }, []);

    // Determine the items to display in the FlatTree
    const displayItemsForFlatTree = useMemo(() => {
      if (isTreeCurrentlyFiltered && focusNodeIds && focusNodeIds.size > 0) {
        // Filtering is ON and there are matches: show only direct matches and their ancestors
        const ancestorChainNodeIds = new Set<UniqueIdentifier>();
        focusNodeIds.forEach((directMatchId) => {
          let currentParentValue = itemMap.get(directMatchId)?.parentValue;
          while (currentParentValue) {
            const parentItem = itemMap.get(currentParentValue);
            if (parentItem) {
              ancestorChainNodeIds.add(parentItem.value);
              currentParentValue = parentItem.parentValue;
            } else {
              currentParentValue = undefined;
            }
          }
        });

        const allVisibleNodeIds = new Set([
          ...focusNodeIds,
          ...ancestorChainNodeIds,
        ]);

        return items
          .filter((item) => allVisibleNodeIds.has(item.value))
          .map((item) => ({
            ...item,
            // isDirectMatch is true if this item is one of the primary filter targets
            isDirectMatchForFilter: focusNodeIds.has(String(item.value)),
          }));
      } else {
        // Not filtering, or filter is on but no matches: show all items
        // Mark all as not being "direct matches" in the context of filtering
        return items.map((item) => ({
          ...item,
          isDirectMatchForFilter: false,
        }));
      }
    }, [items, focusNodeIds, isTreeCurrentlyFiltered, itemMap]);

    const flatTree = useHeadlessFlatTree_unstable(displayItemsForFlatTree, {
      openItems,
      onOpenChange: (_, data) => setOpenItems(new Set(data.openItems)),
      defaultOpenItems: [], // Controlled mode
    });

    useEffect(() => {
      const loadTreeData = async () => {
        try {
          setLoading(true);
          initialOpen.clear(); // Clear initial open set before loading
          const treeData = await getInitialTree();
          setTreeData(treeData); // Store for recursive search
          const initialFlatItems = convertToFlatData(
            treeData,
            null,
            initialOpen // Populate initialOpen during conversion
          );
          setItems(initialFlatItems);
          setOpenItems(new Set(initialOpen)); // Set openItems based on initially expanded nodes
          setLoading(false);
        } catch (error) {
          console.error("Failed to load tree data:", error);
          setError("Failed to load tree data");
          setLoading(false); // Ensure loading is set to false on error
        }
      };
      loadTreeData();
    }, [reloadKey]);

    // --- ALL HOOKS MUST BE CALLED BEFORE THIS POINT ---

    // --- Rename Node Logic ---
    const handleRenameNode = useCallback(
      async (id: string, newLabel: string) => {
        const success = await updateNode(id, newLabel);
        if (success) {
          setItems((prevItems) =>
            updateNodeLabelInFlatList(prevItems, id, newLabel)
          );
          // If items array is updated, and activeFilterQuery is present,
          // filteredDisplayItems will recompute due to `items` being a dependency.
          // This ensures the filter reflects the new label.
        } else {
          await showMessage("Failed to rename note.", {
            title: "Rename note",
            kind: "error",
          });
        }
      },
      [] // `items` is the key data that changes, `filteredDisplayItems` depends on it.
    );

    const closeContextMenu = useCallback(() => {
      setContextMenu(null);
    }, []);

    const handleNodeContextMenu = useCallback(
      (nodeId: string, position: { x: number; y: number }) => {
        onNodeSelect(nodeId);
        setContextMenu({
          nodeId,
          x: position.x,
          y: position.y,
        });
      },
      [onNodeSelect]
    );

    const handleDuplicateNode = useCallback(
      async (nodeId: string) => {
        const parentId = items.find((item) => item.value === nodeId)?.parentValue;
        const duplicated = await duplicateNode(nodeId);
        if (!duplicated) {
          await showMessage("Failed to duplicate note.", {
            title: "Duplicate note",
            kind: "error",
          });
          return;
        }

        await reloadTreeFromBackend(openItems);
        onNodeSelect(duplicated.id);
        if (parentId !== undefined) {
          setOpenItems((prevOpen) => new Set(prevOpen).add(parentId));
        }
        focusTreeNode(duplicated.id);
      },
      [items, openItems, reloadTreeFromBackend, onNodeSelect]
    );

    const handleContextMenuAction = useCallback(
      async (action: NodeContextMenuAction) => {
        if (!contextMenu) return;
        const { nodeId } = contextMenu;
        closeContextMenu();

        if (action === "rename") {
          setRenameRequestId(nodeId);
          return;
        }
        if (action === "duplicate") {
          await handleDuplicateNode(nodeId);
          return;
        }
        if (action === "export") {
          await onExportNode(nodeId);
          focusTreeNode(nodeId, { retry: true });
          return;
        }
        if (action === "delete") {
          onDeleteNode(nodeId);
        }
      },
      [
        contextMenu,
        closeContextMenu,
        handleDuplicateNode,
        onExportNode,
        onDeleteNode,
      ]
    );

    // --- Drag and Drop Logic ---
    const sensors = useSensors(
      useSensor(PointerSensor, {
        activationConstraint: {
          distance: 5, // Small drag threshold to avoid accidental drags
        },
      })
    );

    // Handles drag end: moves item if valid
    const handleDragEnd = useCallback(
      async (event: DragEndEvent) => {
        const { active, over } = event;
        if (!active?.id) return;
        const activeNodeExists = items.some((item) => item.value === active.id);
        if (!activeNodeExists) {
          console.warn(`DragEnd: Active node ${active.id} not found in items.`);
          return;
        }

        let nextOpenItems = new Set(openItems);
        let moveSucceeded = false;

        if (over && active.id !== over.id && over.id !== "root-drop-area") {
          const targetNodeExists = items.some((item) => item.value === over.id);
          if (!targetNodeExists) {
            console.warn(`DragEnd: Target node ${over.id} not found in items.`);
            return;
          }

          if (wouldExceedMaxLevel(items, active.id, over.id)) {
            await showMessage(DEPTH_LIMIT_MOVE_MESSAGE, {
              title: "Move note",
              kind: "warning",
            });
            return;
          }

          const movePlan = buildReparentMove(items, active.id, over.id);
          if (!movePlan) return;

          setItems(movePlan.items);
          if (movePlan.openParentId && !nextOpenItems.has(movePlan.openParentId)) {
            nextOpenItems = new Set(nextOpenItems).add(movePlan.openParentId);
          }

          moveSucceeded = await moveNode(
            String(active.id),
            String(over.id),
            movePlan.sortOrder
          );
        } else if (active.id && (!over || over.id === "root-drop-area")) {
          if (wouldExceedMaxLevel(items, active.id, null)) {
            await showMessage(DEPTH_LIMIT_MOVE_MESSAGE, {
              title: "Move note",
              kind: "warning",
            });
            return;
          }

          const movePlan = buildReparentMove(items, active.id, undefined);
          if (!movePlan) return;

          setItems(movePlan.items);
          moveSucceeded = await moveNode(
            String(active.id),
            null,
            movePlan.sortOrder
          );
        }

        if (moveSucceeded) {
          await reloadTreeFromBackend(nextOpenItems);
        } else if (over && active.id !== over.id) {
          await reloadTreeFromBackend(openItems);
        }
      },
      [items, openItems, reloadTreeFromBackend]
    );

    const handleDragStart = useCallback((_event: DragStartEvent) => {
      suppressClickAfterDragRef.current = true;
    }, []);

    const handleDragEndWithCleanup = useCallback(
      async (event: DragEndEvent) => {
        try {
          await handleDragEnd(event);
        } finally {
          requestAnimationFrame(() => {
            suppressClickAfterDragRef.current = false;
          });
        }
      },
      [handleDragEnd]
    );

    // --- Move Up/Down Logic (for keyboard or toolbar) ---
    const persistSiblingReorder = useCallback(
      async (id: string, direction: "up" | "down") => {
        const plan = buildSiblingReorderMove(items, id, direction);
        if (!plan) return;

        setItems(plan.items);

        const moveSucceeded = await moveNode(id, plan.parentId, plan.sortOrder);
        if (moveSucceeded) {
          const freshTreeData = await getInitialTree();
          setTreeData(freshTreeData);
        } else {
          await reloadTreeFromBackend(openItems);
        }
      },
      [items, openItems, reloadTreeFromBackend]
    );

    const moveNodeUp = useCallback(
      (id: string) => {
        void persistSiblingReorder(id, "up");
      },
      [persistSiblingReorder]
    );
    const moveNodeDown = useCallback(
      (id: string) => {
        void persistSiblingReorder(id, "down");
      },
      [persistSiblingReorder]
    );

    const processTreeKeyboard = useCallback(
      (event: KeyboardEvent) => {
        if (document.querySelector('[role="dialog"]')) return;

        const target = event.target as HTMLElement;
        if (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable
        ) {
          return;
        }
        if (target.closest(".node-context-menu, .editor-context-menu")) return;
        if (target.closest(".toolbar, .search-bar, #note-editor, .editor-textarea, .splitter")) {
          return;
        }

        const active = document.activeElement as HTMLElement | null;
        if (
          active?.closest(
            ".toolbar, .search-bar, #note-editor, .editor-textarea, [role='dialog'], .splitter",
          )
        ) {
          return;
        }

        const focusInTree = !!(
          active && treeScrollerRef.current?.contains(active)
        );
        const focusLostToChrome =
          !active ||
          active === document.body ||
          active === document.documentElement;
        const focusInTreePanel = !!active?.closest(
          ".tree-panel, .tree-scroller",
        );

        if (!focusInTree && !focusLostToChrome && !focusInTreePanel) return;
        if (!selectedNodeId && !focusInTree && !focusInTreePanel) return;

        const visibleItems = Array.from(flatTree.items());
        const visibleIds = visibleItems.map((item) => String(item.value));

        const keyboardItemMeta = new Map<string, TreeKeyboardItemMeta>();
        for (const item of visibleItems) {
          const id = String(item.value);
          const parentValue = itemMap.get(item.value)?.parentValue;
          keyboardItemMeta.set(id, {
            parentId: parentValue !== undefined ? String(parentValue) : null,
            hasChildren: parentIds.has(item.value),
            isOpen: openItems.has(item.value),
          });
        }

        const scroller = treeScrollerRef.current;
        const rowEl = selectedNodeId
          ? document.getElementById(`tree-item-${selectedNodeId}`)
          : visibleIds.length > 0
            ? document.getElementById(`tree-item-${visibleIds[0]}`)
            : null;
        const rowHeight = rowEl?.getBoundingClientRect().height ?? 32;
        const pageSize = computeTreePageSize(
          scroller?.clientHeight ?? 0,
          rowHeight,
        );

        const action = resolveTreeKeyboardAction({
          visibleIds,
          itemMeta: keyboardItemMeta,
          currentId: selectedNodeId,
          pageSize,
          key: event.key,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
        });

        if (!action) return;

        event.preventDefault();
        event.stopPropagation();

        switch (action.type) {
          case "select":
            onNodeSelect(action.id);
            focusTreeNode(action.id);
            break;
          case "toggleOpen":
            toggleNodeOpen(action.id);
            if (!active?.closest('[role="treeitem"]')) {
              focusTreeNode(action.id);
            }
            break;
          case "delete":
            onDeleteNode(action.id);
            break;
          case "activate":
            cancelTreeFocus();
            onActivateNode?.();
            break;
          case "leave":
            cancelTreeFocus();
            if (action.direction === "forward") {
              const splitter = document.querySelector(
                '.splitter[tabindex="0"]',
              ) as HTMLElement | null;
              if (splitter) {
                splitter.focus();
              } else {
                const editor = document.getElementById("note-editor");
                if (editor) editor.focus();
                else onActivateNode?.();
              }
            } else {
              const buttons = document.querySelectorAll<HTMLButtonElement>(
                ".toolbar button:not(:disabled)",
              );
              buttons[buttons.length - 1]?.focus();
            }
            break;
          case "suppress":
            break;
        }
      },
      [
        flatTree,
        itemMap,
        parentIds,
        openItems,
        selectedNodeId,
        onNodeSelect,
        onDeleteNode,
        onActivateNode,
        toggleNodeOpen,
      ],
    );

    useEffect(() => {
      document.addEventListener("keydown", processTreeKeyboard, true);
      return () =>
        document.removeEventListener("keydown", processTreeKeyboard, true);
    }, [processTreeKeyboard]);

    // --- Insert Root After Selected ---
    const insertRootAfterSelected = useCallback(
      async (selectedId: string | null) => {
        // Use stable references inside the callback
        const allItems = items;
        const currentOpenItems = openItems;

        // Find all root nodes (parentValue === undefined)
        const rootItems = allItems.filter(
          (item) => item.parentValue === undefined
        );

        let targetSortOrder = rootItems.length; // Default: append at the end (index = count)
        let rootAncestorToInsertAfter: FlatItem | undefined = undefined;

        if (selectedId) {
          // Find the selected item *among all items* first
          const selectedItem = allItems.find(
            (item) => item.value === selectedId
          );

          if (selectedItem) {
            // Find the root ancestor of the selected item
            rootAncestorToInsertAfter = findRootAncestor(
              selectedItem.value,
              allItems
            );

            if (rootAncestorToInsertAfter) {
              // Find the index of this ancestor within the list of root items
              const rootAncestorIndex = rootItems.findIndex(
                (item) => item.value === rootAncestorToInsertAfter!.value
              );
              if (rootAncestorIndex !== -1) {
                // The target sort order is the index + 1
                targetSortOrder = rootAncestorIndex + 1;
              }
            }
          }
        }

        // Add to backend
        const newNode = await addNode(null, formatDefaultNodeTitle());
        if (newNode) {
          // Move the new node to the correct position if needed
          await moveNode(newNode.id, null, targetSortOrder);

          // Reload tree from backend
          const treeData = await getInitialTree();
          const newFlatItems = convertToFlatData(
            treeData,
            null,
            currentOpenItems // Pass the set to preserve open state
          );
          setItems(newFlatItems);
          // Ensure the open state set itself is updated if convertToFlatData modified it
          setOpenItems(currentOpenItems);
        }
      },
      [items, openItems] // Dependencies
    );

    useEffect(() => {
      if (!selectedNodeId) {
        onCanAddChildChange?.(false);
        return;
      }
      onCanAddChildChange?.(
        canAddChildAtLevel(nodeLevel(items, selectedNodeId)),
      );
    }, [items, selectedNodeId, onCanAddChildChange]);

    // --- Insert Child First ---
    const insertChildFirst = useCallback(async (parentId: string) => {
      if (!canAddChildAtLevel(nodeLevel(items, parentId))) {
        await showMessage(DEPTH_LIMIT_ADD_MESSAGE, {
          title: "Add note",
          kind: "warning",
        });
        return;
      }
      const newNode = await addNode(parentId, formatDefaultNodeTitle());
      if (newNode) {
        setOpenItems((prevOpen) => {
          if (prevOpen.has(parentId)) return prevOpen;
          return new Set(prevOpen).add(parentId);
        });
        // Reload tree from backend
        const treeData = await getInitialTree();
        const initialFlatItems = convertToFlatData(treeData, null, initialOpen);
        setItems(initialFlatItems);
      }
    }, [items]);

    // --- EXPOSE METHODS VIA REF ---
    useImperativeHandle(
      ref,
      () => ({
        moveNodeUp,
        moveNodeDown,
        insertRootAfterSelected,
        insertChildFirst,
        hasChildren: (id: string) => {
          return items.some((item) => item.parentValue === id);
        },
        getParentId: (id: string): string | null => {
          const item = items.find((i) => i.value === id);
          // Ensure parentValue is treated as string if it exists
          return item?.parentValue ? String(item.parentValue) : null;
        },
        getNextSiblingId: (id: string): string | null => {
          const currentIndex = items.findIndex((i) => i.value === id); // Use full 'items' list
          if (currentIndex === -1) return null;
          const currentItem = items[currentIndex];
          for (let i = currentIndex + 1; i < items.length; i++) {
            if (items[i].parentValue === currentItem.parentValue) {
              return String(items[i].value);
            }
            // Stop if we encounter a node with a different parent at the same or shallower level
            // This logic needs to correctly identify end of sibling group in a flat list
            if (items[i].parentValue !== currentItem.parentValue) {
              let tempParent = items[i].parentValue;
              let isDescendantOfOriginalParent = false;
              while (tempParent) {
                if (tempParent === currentItem.parentValue) {
                  isDescendantOfOriginalParent = true;
                  break;
                }
                const parentItem = itemMap.get(tempParent);
                tempParent = parentItem ? parentItem.parentValue : undefined;
              }
              if (
                !isDescendantOfOriginalParent &&
                items[i].parentValue !== undefined
              )
                break;
            }
          }
          return null;
        },
        getPreviousSiblingId: (id: string): string | null => {
          const currentIndex = items.findIndex((i) => i.value === id); // Use full 'items' list
          if (currentIndex === -1) return null;
          const currentItem = items[currentIndex];
          for (let i = currentIndex - 1; i >= 0; i--) {
            if (items[i].parentValue === currentItem.parentValue) {
              return String(items[i].value);
            }
            // Stop if we encounter a node with a different parent at the same or shallower level
            if (items[i].parentValue !== currentItem.parentValue) {
              let tempParent = items[i].parentValue;
              let isDescendantOfOriginalParent = false;
              while (tempParent) {
                if (tempParent === currentItem.parentValue) {
                  isDescendantOfOriginalParent = true;
                  break;
                }
                const parentItem = itemMap.get(tempParent);
                tempParent = parentItem ? parentItem.parentValue : undefined;
              }
              if (
                !isDescendantOfOriginalParent &&
                items[i].parentValue !== undefined
              )
                break;
            }
          }
          return null;
        },
        removeItemAndDescendants: (id: string) => {
          setItems((currentItems) => {
            const itemsToRemove = new Set<UniqueIdentifier>([id]);
            const stack = [id];

            // Find all descendants
            while (stack.length > 0) {
              const currentId = stack.pop()!;
              currentItems.forEach((item) => {
                if (item.parentValue === currentId) {
                  itemsToRemove.add(item.value);
                  stack.push(item.value as string);
                }
              });
            }

            // Filter out the node and its descendants
            return currentItems.filter(
              (item) => !itemsToRemove.has(item.value)
            );
          });
        },
        ensureNodeIsOpen: (id: string) => {
          setOpenItems((prevOpen) => {
            if (prevOpen.has(id)) {
              return prevOpen; // Already open, return same set
            }
            return new Set(prevOpen).add(id); // Return new set with id added
          });
        },
        getAllNodeIdsInOrder: () => {
          if (!flatTree) return [];
          const ids: string[] = [];
          for (const item of flatTree.items()) {
            ids.push(item.value.toString());
          }
          return ids;
        },
        scrollNodeIntoView: (id: string) => {
          const element = document.getElementById(`tree-item-${id}`);
          if (element) {
            element.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
        },
        focusNode: (id: string) => {
          focusTreeNode(id);
        },
        getAllNodeIdsRecursive: () => {
          return collectAllNodeIds(treeData);
        },
      }),
      [
        items,
        openItems,
        moveNodeUp,
        moveNodeDown,
        insertRootAfterSelected,
        insertChildFirst,
        flatTree,
        treeData,
        itemMap,
      ]
    );

    // --- NOW check loading and error states ---
    if (loading) {
      return <div role="status">Loading notes</div>;
    }

    if (error) {
      return <div role="alert">Error: {error}</div>;
    }

    // Precompute hierarchy guide-line metadata for the visible rows.
    const visibleItems = Array.from(flatTree.items());
    const guideMap = buildGuideMap(
      visibleItems.map((item) => ({
        value: item.value,
        level: item.level ?? 1,
      })),
      itemMap
    );

    // If not loading and no error, render the tree
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          width: "100%",
        }}
      >
        <div ref={treeScrollerRef} className="tree-scroller">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEndWithCleanup}
          >
            <DropArea id="root-drop-area">
              <div
                style={{
                  height: "100%",
                  width: "100%",
                  paddingTop: "2px",
                  boxSizing: "border-box",
                }}
                onContextMenu={(e) => e.preventDefault()}
              >
                <FlatTree aria-label="Notes" {...flatTree.getTreeProps()}>
                  {visibleItems.map((item) => {
                    // item.getTreeItemProps() returns all necessary props including our custom ones.
                    const allGeneratedProps = item.getTreeItemProps();
                    // allGeneratedProps includes: value, layout, isDirectMatchForFilter, open, level, aria-* etc.

                    const canDrag = true;
                    // Determine if the filter mode is active *and* has found focusable matches
                    const isFilterModeActiveWithMatches = !!(
                      isTreeCurrentlyFiltered && // Apply !! to ensure boolean
                      focusNodeIds &&
                      focusNodeIds.size > 0
                    );

                    return (
                      <SelectableDraggableFlatTreeItem
                        key={allGeneratedProps.value}
                        id={`tree-item-${allGeneratedProps.value}`}
                        // Pass all props from Fluent UI to SelectableDraggableFlatTreeItem
                        // This includes 'value', 'layout', 'open', 'level', and our 'isDirectMatchForFilter'
                        {...allGeneratedProps}
                        // Explicitly pass props that SelectableDraggableFlatTreeItem needs for its own logic,
                        // or to override if necessary.
                        selectedNodeId={selectedNodeId}
                        onNodeSelect={onNodeSelect}
                        onRename={handleRenameNode}
                        hasChildren={parentIds.has(allGeneratedProps.value)}
                        onToggleOpen={() =>
                          toggleNodeOpen(allGeneratedProps.value)
                        }
                        isDraggableProp={canDrag}
                        // Props for color logic (isDirectMatchForFilter is already in allGeneratedProps)
                        isFilterModeActive={isFilterModeActiveWithMatches}
                        isTreeCurrentlyFiltered={isTreeCurrentlyFiltered}
                        allNodesWithSearchMatches={allNodesWithSearchMatches}
                        searchQuery={searchQuery}
                        suppressClickAfterDragRef={suppressClickAfterDragRef}
                        guide={guideMap.get(allGeneratedProps.value)}
                        onNodeContextMenu={handleNodeContextMenu}
                        renameRequestId={renameRequestId}
                        onRenameRequestHandled={() => setRenameRequestId(null)}
                      />
                    );
                  })}
                </FlatTree>
              </div>
            </DropArea>
          </DndContext>
          <NodeContextMenu
            open={contextMenu !== null}
            position={
              contextMenu
                ? { x: contextMenu.x, y: contextMenu.y }
                : null
            }
            onAction={(action) => {
              void handleContextMenuAction(action);
            }}
            onClose={({ reason, restoreFocus }) => {
              const nodeId = contextMenu?.nodeId;
              closeContextMenu();
              if (reason !== "dismiss" || !nodeId) return;
              if (restoreFocus) {
                focusTreeNode(nodeId, { retry: true });
                return;
              }
              requestAnimationFrame(() => {
                const active = document.activeElement as HTMLElement | null;
                if (
                  active?.closest('[role="treeitem"]') &&
                  active.id !== `tree-item-${nodeId}`
                ) {
                  return;
                }
                if (
                  !active ||
                  active === document.body ||
                  active.closest(".tree-panel, .tree-scroller")
                ) {
                  focusTreeNode(nodeId, { retry: true });
                }
              });
            }}
          />
        </div>
      </div>
    );
  }
);

TreeComponent.displayName = "TreeComponent";

export default TreeComponent;

// Helper function to find a node and update its label in the nested structure
const updateNodeLabelInNestedData = (
  nodes: OriginalTreeNodeData[],
  nodeId: string,
  newLabel: string
): boolean => {
  for (const node of nodes) {
    if (node.id === nodeId) {
      node.label = newLabel;
      return true; // Found and updated
    }
    if (node.children) {
      if (updateNodeLabelInNestedData(node.children, nodeId, newLabel)) {
        return true; // Found and updated in children
      }
    }
  }
  return false; // Not found in this branch
};
