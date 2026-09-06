import { invoke } from "@tauri-apps/api/core";
import { showMessage } from "./dialogs";

export interface TreeNodeData {
  id: string;
  label: string;
  children?: TreeNodeData[];
  isExpanded?: boolean;
  isDraggable?: boolean;
}

export async function getInitialTree(): Promise<TreeNodeData[]> {
  try {
    const treeData = await invoke<TreeNodeData[]>("get_tree");
    return treeData;
  } catch (error) {
    console.error("Failed to fetch tree data from Rust:", error);
    await showMessage(`Error loading data: ${error}`, {
      title: "Tree Note",
      kind: "error",
    });
    return [];
  }
}

export function formatDefaultNodeTitle(date: Date = new Date()): string {
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = weekdays[date.getDay()];
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const year = String(date.getFullYear()).slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  return `${day} ${hours}:${minutes}:${seconds} ${year}/${month}/${dayOfMonth}`;
}

export async function addNode(
  parentId: string | null,
  label: string
): Promise<TreeNodeData | null> {
  try {
    const node = await invoke<TreeNodeData>("add_node", { parentId, label });
    return node;
  } catch (error) {
    console.error("Failed to add node:", error);
    return null;
  }
}

export async function updateNode(
  id: string,
  newLabel: string
): Promise<boolean> {
  try {
    await invoke("update_node", { id, newLabel });
    return true;
  } catch (error) {
    console.error("Failed to update node:", error);
    return false;
  }
}

export async function deleteNode(id: string): Promise<boolean> {
  try {
    await invoke("delete_node", { id });
    return true;
  } catch (error) {
    console.error("Failed to delete node:", error);
    return false;
  }
}

export async function moveNode(
  id: string,
  newParentId: string | null,
  newSortOrder: number
): Promise<boolean> {
  try {
    await invoke("move_node", { id, newParentId, newSortOrder });
    return true;
  } catch (error) {
    console.error("Failed to move node:", error);
    return false;
  }
}

export async function duplicateNode(
  id: string
): Promise<TreeNodeData | null> {
  try {
    const node = await invoke<TreeNodeData>("duplicate_node", { id });
    return node;
  } catch (error) {
    console.error("Failed to duplicate node:", error);
    return null;
  }
}

export function sanitizeExportLabel(label: string): string {
  const sanitized = label
    .trim()
    .split("")
    .map((c) => (/[a-zA-Z0-9\-_]/.test(c) ? c : "_"))
    .join("")
    .slice(0, 50);
  if (!sanitized || /^_+$/.test(sanitized)) return "branch";
  return sanitized;
}

export async function exportBranch(id: string, path: string): Promise<string | null> {
  try {
    const savedPath = await invoke<string>("export_branch", { id, path });
    return savedPath;
  } catch (error) {
    console.error("Failed to export branch:", error);
    return null;
  }
}
