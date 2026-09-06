import type { FC } from "react";
import { Add, Delete, Down, Settings, Tree, Up } from "./icons";

interface ToolbarProps {
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMove: boolean;
  onNewTree: () => void;
  onNewChild: () => void;
  canNewChild: boolean;
  onDelete: () => void;
  canDelete: boolean;
  onOpenOptions: () => void;
}

const Toolbar: FC<ToolbarProps> = ({
  onMoveUp,
  onMoveDown,
  canMove,
  onNewTree,
  onNewChild,
  canNewChild,
  onDelete,
  canDelete,
  onOpenOptions,
}) => {
  return (
    <div className="toolbar">
      <button
        type="button"
        title="New Tree"
        aria-label="New Tree"
        onClick={onNewTree}
      >
        <Tree width={18} height={18} aria-hidden={true} />
      </button>
      <button
        type="button"
        title="New Child Note"
        aria-label="New Child Note"
        onClick={onNewChild}
        disabled={!canNewChild}
      >
        <Add width={18} height={18} aria-hidden={true} />
      </button>

      <div className="toolbar-divider" />

      <button
        type="button"
        title="Move Note Up"
        aria-label="Move Note Up"
        onClick={onMoveUp}
        disabled={!canMove}
      >
        <Up width={18} height={18} aria-hidden={true} />
      </button>
      <button
        type="button"
        title="Move Note Down"
        aria-label="Move Note Down"
        onClick={onMoveDown}
        disabled={!canMove}
      >
        <Down width={18} height={18} aria-hidden={true} />
      </button>

      <div className="toolbar-divider" />

      <button
        type="button"
        title="Delete Note"
        aria-label="Delete Note"
        onClick={onDelete}
        disabled={!canDelete}
      >
        <Delete width={18} height={18} aria-hidden={true} />
      </button>

      <div className="toolbar-spacer" />

      <button
        type="button"
        title="Options"
        aria-label="Options"
        onClick={onOpenOptions}
      >
        <Settings width={18} height={18} aria-hidden={true} />
      </button>
    </div>
  );
};

export default Toolbar;
