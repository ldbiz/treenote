import { useEffect, useState } from "react";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from "@fluentui/react-components";

interface NotebookNameDialogProps {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  initialName?: string;
  busy?: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

export default function NotebookNameDialog({
  open,
  title,
  message = "Enter a notebook name.",
  confirmLabel = "Create",
  initialName = "",
  busy = false,
  onConfirm,
  onCancel,
}: NotebookNameDialogProps) {
  const [name, setName] = useState(initialName);

  useEffect(() => {
    if (open) setName(initialName);
  }, [open, initialName]);

  return (
    <Dialog
      open={open}
      modalType="alert"
      onOpenChange={(_, data) => {
        if (!data.open && !busy) onCancel();
      }}
    >
      <DialogSurface className="app-dialog-surface">
        <DialogBody className="app-dialog-body">
          <DialogTitle className="app-dialog-title">{title}</DialogTitle>
          <DialogContent className="app-dialog-content">
            <p>{message}</p>
            <label className="options-field">
              <span className="options-field-label">Notebook name</span>
              <input
                className="options-control"
                value={name}
                disabled={busy}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && name.trim() && !busy) {
                    onConfirm(name.trim());
                  }
                }}
              />
            </label>
          </DialogContent>
          <DialogActions className="app-dialog-actions">
            <button
              type="button"
              className="app-dialog-button"
              disabled={busy}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="app-dialog-button"
              disabled={busy || !name.trim()}
              onClick={() => onConfirm(name.trim())}
            >
              {busy ? "Working…" : confirmLabel}
            </button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
