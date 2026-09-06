import { useCallback, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { readClipboardText, writeClipboardText } from "../lib/clipboard";
import {
  usePopupMenu,
  type PopupMenuCloseDetail,
} from "./popupMenu";

export type EditorContextMenuAction = "cut" | "copy" | "paste" | "selectAll";

function restoreSelection(
  target: HTMLTextAreaElement | HTMLInputElement,
  start: number,
  end: number
): void {
  target.focus();
  target.setSelectionRange(start, end);
}

function applySplicedValue(
  target: HTMLTextAreaElement | HTMLInputElement,
  nextValue: string,
  cursor: number,
  onValueChange?: (value: string) => void
): void {
  onValueChange?.(nextValue);
  queueMicrotask(() => target.setSelectionRange(cursor, cursor));
}

type EditorContextMenuProps = {
  open: boolean;
  position: { x: number; y: number } | null;
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  onAction: (action: EditorContextMenuAction) => void | Promise<void>;
  onClose: (detail: PopupMenuCloseDetail) => void;
};

export async function runEditorAction(
  action: EditorContextMenuAction,
  target: HTMLTextAreaElement | HTMLInputElement,
  onValueChange?: (value: string) => void
): Promise<void> {
  target.focus();
  const start = target.selectionStart ?? 0;
  const end = target.selectionEnd ?? 0;
  const value = target.value;
  const selectedText = value.slice(start, end);

  switch (action) {
    case "copy": {
      if (!selectedText) return;
      const copied = await writeClipboardText(selectedText);
      if (!copied) {
        document.execCommand("copy");
      }
      return;
    }
    case "cut": {
      if (!selectedText) return;
      const copied = await writeClipboardText(selectedText);
      if (!copied) {
        restoreSelection(target, start, end);
        document.execCommand("copy");
      }
      restoreSelection(target, start, end);
      if (document.execCommand("delete")) {
        return;
      }
      applySplicedValue(
        target,
        value.slice(0, start) + value.slice(end),
        start,
        onValueChange
      );
      return;
    }
    case "paste": {
      const pasteText = await readClipboardText();
      if (pasteText == null) return;
      restoreSelection(target, start, end);
      if (document.execCommand("insertText", false, pasteText)) {
        return;
      }
      applySplicedValue(
        target,
        value.slice(0, start) + pasteText + value.slice(end),
        start + pasteText.length,
        onValueChange
      );
      return;
    }
    case "selectAll":
      target.select();
      return;
  }
}

function MenuItem({
  disabled,
  onActivate,
  children,
}: {
  disabled?: boolean;
  onActivate: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (disabled) return;
        onActivate();
      }}
    >
      {children}
    </button>
  );
}

export default function EditorContextMenu({
  open,
  position,
  canCut,
  canCopy,
  canPaste,
  onAction,
  onClose,
}: EditorContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  const onDismiss = useCallback(
    ({ restoreFocus }: { restoreFocus: boolean }) => {
      onClose({ reason: "dismiss", restoreFocus });
    },
    [onClose]
  );

  usePopupMenu(open, menuRef, onDismiss);

  if (!open || !position) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="node-context-menu"
      style={{ top: position.y, left: position.x }}
      role="menu"
      aria-label="Editor"
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuItem disabled={!canCut} onActivate={() => void onAction("cut")}>
        Cut
      </MenuItem>
      <MenuItem disabled={!canCopy} onActivate={() => void onAction("copy")}>
        Copy
      </MenuItem>
      <MenuItem disabled={!canPaste} onActivate={() => void onAction("paste")}>
        Paste
      </MenuItem>
      <div className="node-context-menu-divider" role="separator" />
      <MenuItem onActivate={() => void onAction("selectAll")}>
        Select all
      </MenuItem>
    </div>,
    document.body
  );
}
