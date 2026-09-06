import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from "@fluentui/react-components";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
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
          <DialogContent className="app-dialog-content">{message}</DialogContent>
          <DialogActions className="app-dialog-actions">
            <button
              type="button"
              className="app-dialog-button"
              disabled={busy}
              onClick={onCancel}
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              className="app-dialog-button app-dialog-danger"
              disabled={busy}
              onClick={onConfirm}
            >
              {busy ? "Deleting…" : confirmLabel}
            </button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
