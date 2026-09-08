function focusTreeNodeElement(id: string): boolean {
  const element = document.getElementById(`tree-item-${id}`);
  element?.focus();
  element?.scrollIntoView({ behavior: "auto", block: "nearest" });
  return document.activeElement === element;
}

const rafIds: number[] = [];
const timeoutIds: number[] = [];

export function cancelTreeFocus(): void {
  for (const id of rafIds) cancelAnimationFrame(id);
  for (const id of timeoutIds) clearTimeout(id);
  rafIds.length = 0;
  timeoutIds.length = 0;
}

export type FocusTreeNodeOptions = {
  retry?: boolean;
};

/** Focus a tree row and scroll it into view. Retries only when a dialog/menu may still hold focus. */
export function focusTreeNode(
  id: string,
  options: FocusTreeNodeOptions = {},
): void {
  cancelTreeFocus();
  const retry = options.retry === true;

  const raf1 = requestAnimationFrame(() => {
    const raf2 = requestAnimationFrame(() => {
      if (focusTreeNodeElement(id) || !retry) return;
      timeoutIds.push(window.setTimeout(() => focusTreeNodeElement(id), 50));
      timeoutIds.push(window.setTimeout(() => focusTreeNodeElement(id), 150));
    });
    rafIds.push(raf2);
  });
  rafIds.push(raf1);
}
