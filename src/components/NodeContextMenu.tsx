import { useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  usePopupMenu,
  type PopupMenuCloseDetail,
} from "./popupMenu";

export type NodeContextMenuAction = "rename" | "duplicate" | "export" | "delete";

type NodeContextMenuProps = {
  open: boolean;
  position: { x: number; y: number } | null;
  stats?: string;
  onAction: (action: NodeContextMenuAction) => void;
  onClose: (detail: PopupMenuCloseDetail) => void;
};

export default function NodeContextMenu({
  open,
  position,
  stats,
  onAction,
  onClose,
}: NodeContextMenuProps) {
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
      aria-label={stats ? `Note actions. ${stats}` : "Note actions"}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button type="button" role="menuitem" onClick={() => onAction("rename")}>
        Rename
      </button>

      <div className="node-context-menu-divider" role="separator" />

      <button type="button" role="menuitem" onClick={() => onAction("duplicate")}>
        Duplicate
      </button>
      <button type="button" role="menuitem" onClick={() => onAction("export")}>
        Export
      </button>

      <div className="node-context-menu-divider" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="node-context-menu-danger"
        onClick={() => onAction("delete")}
      >
        Delete
      </button>
      {stats ? (
        <>
          <div className="node-context-menu-divider" role="separator" />
          <div className="node-context-menu-info" aria-hidden="true">
            {stats}
          </div>
        </>
      ) : null}
    </div>,
    document.body
  );
}
