import { useEffect, type RefObject } from "react";

export type PopupMenuCloseDetail = {
  reason: "dismiss" | "action";
  restoreFocus?: boolean;
};

export function isContextMenuKey(event: {
  key: string;
  shiftKey: boolean;
}): boolean {
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}

export function isAriaDisabled(el: Element): boolean {
  return el.getAttribute("aria-disabled") === "true";
}

function menuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
}

export function usePopupMenu(
  open: boolean,
  menuRef: RefObject<HTMLElement | null>,
  onDismiss: (detail: { restoreFocus: boolean }) => void
): void {
  useEffect(() => {
    if (!open) return;

    const menu = menuRef.current;
    if (!menu) return;

    const items = menuItems(menu);
    const firstEnabled =
      items.find((item) => !isAriaDisabled(item)) ?? items[0];
    firstEnabled?.focus();

    const focusAt = (index: number) => {
      const list = menuItems(menu);
      if (!list.length) return;
      const wrapped = ((index % list.length) + list.length) % list.length;
      list[wrapped]?.focus();
    };

    const currentIndex = () => {
      const list = menuItems(menu);
      return list.findIndex((item) => item === document.activeElement);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!menu.contains(event.target as Node)) return;

      const list = menuItems(menu);
      const index = currentIndex();

      switch (event.key) {
        case "Escape":
          event.preventDefault();
          event.stopPropagation();
          onDismiss({ restoreFocus: true });
          return;
        case "Tab":
          event.preventDefault();
          event.stopPropagation();
          onDismiss({ restoreFocus: true });
          return;
        case "ArrowDown":
          event.preventDefault();
          focusAt(index < 0 ? 0 : index + 1);
          return;
        case "ArrowUp":
          event.preventDefault();
          focusAt(index < 0 ? list.length - 1 : index - 1);
          return;
        case "Home":
          event.preventDefault();
          focusAt(0);
          return;
        case "End":
          event.preventDefault();
          focusAt(list.length - 1);
          return;
        case "Enter":
        case " ":
          if (
            document.activeElement &&
            isAriaDisabled(document.activeElement)
          ) {
            event.preventDefault();
            event.stopPropagation();
          }
          return;
        default:
          return;
      }
    };

    const dismissIfOutside = (target: EventTarget | null) => {
      if (menu.contains(target as Node)) return;
      onDismiss({ restoreFocus: false });
    };

    const onMouseDown = (event: MouseEvent) => {
      dismissIfOutside(event.target);
    };
    const onFocusIn = (event: FocusEvent) => {
      dismissIfOutside(event.target);
    };

    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open, menuRef, onDismiss]);
}
