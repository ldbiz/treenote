function focusTreeNodeElement(id: string): boolean {
  const element = document.getElementById(`tree-item-${id}`);
  element?.focus();
  element?.scrollIntoView({ behavior: "auto", block: "nearest" });
  return document.activeElement === element;
}

/** Focus a tree row and scroll it into view. Retries after dialogs release focus traps. */
export function focusTreeNode(id: string): void {
  const attemptFocus = () => {
    if (focusTreeNodeElement(id)) return;
    window.setTimeout(() => focusTreeNodeElement(id), 50);
    window.setTimeout(() => focusTreeNodeElement(id), 150);
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(attemptFocus);
  });
}
