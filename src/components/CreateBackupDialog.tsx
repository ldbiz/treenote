import { useEffect, useState } from "react";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from "@fluentui/react-components";
import { formatBackupLabel } from "../lib/backupList";

interface CreateBackupDialogProps {
  open: boolean;
  busy?: boolean;
  onConfirm: (label: string, locked: boolean) => void;
  onCancel: () => void;
}

export default function CreateBackupDialog({
  open,
  busy = false,
  onConfirm,
  onCancel,
}: CreateBackupDialogProps) {
  const defaultLabel = formatBackupLabel(Math.floor(Date.now() / 1000));
  const [label, setLabel] = useState(defaultLabel);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLabel(formatBackupLabel(Math.floor(Date.now() / 1000)));
    setLocked(false);
  }, [open]);

  return (
    <Dialog
      open={open}
      modalType="modal"
      onOpenChange={(_, data) => {
        if (!data.open && !busy) onCancel();
      }}
    >
      <DialogSurface className="app-dialog-surface">
        <DialogBody className="app-dialog-body">
          <DialogTitle className="app-dialog-title">Back up now</DialogTitle>
          <DialogContent className="app-dialog-content">
            <label className="options-field">
              <span className="options-field-label">Label</span>
              <input
                className="options-control"
                value={label}
                disabled={busy}
                autoFocus
                onChange={(event) => setLabel(event.target.value)}
              />
              <p className="options-field-hint">
                Optional. Leave blank to use the usual timestamp label.
              </p>
            </label>
            <label className="options-field options-checkbox-field">
              <input
                type="checkbox"
                className="options-checkbox"
                checked={locked}
                disabled={busy}
                onChange={(event) => setLocked(event.target.checked)}
              />
              <span className="options-checkbox-label">
                Keep this backup (exclude from automatic cleanup)
              </span>
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
              disabled={busy}
              onClick={() => onConfirm(label, locked)}
            >
              {busy ? "Running…" : "Back up"}
            </button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
