import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
} from "@fluentui/react-components";
import { useCallback, useEffect, useRef } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onAfterClose?: () => void;
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
  onAfterClose,
}: ConfirmDialogProps) {
  const wasOpenRef = useRef(open);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  const focusCancelButton = useCallback(() => {
    const tryFocus = () => cancelButtonRef.current?.focus();
    tryFocus();
    requestAnimationFrame(() => {
      tryFocus();
      requestAnimationFrame(tryFocus);
    });
    window.setTimeout(tryFocus, 0);
    window.setTimeout(tryFocus, 50);
  }, []);

  useEffect(() => {
    if (wasOpenRef.current && !open) {
      onAfterClose?.();
    }
    wasOpenRef.current = open;
  }, [open, onAfterClose]);

  useEffect(() => {
    if (!open) return;
    focusCancelButton();
  }, [open, focusCancelButton]);

  return (
    <Dialog
      open={open}
      modalType="alert"
      onOpenChange={(_, data) => {
        if (data.open) {
          focusCancelButton();
          return;
        }
        if (!busy) onCancel();
      }}
    >
      <DialogSurface className="app-dialog-surface">
        <DialogBody className="app-dialog-body">
          <DialogTitle className="app-dialog-title">{title}</DialogTitle>
          <DialogContent className="app-dialog-content">{message}</DialogContent>
          <DialogActions className="app-dialog-actions">
            <DialogTrigger disableButtonEnhancement action="close">
              <button
                ref={cancelButtonRef}
                type="button"
                className="app-dialog-button"
                disabled={busy}
              >
                {cancelLabel}
              </button>
            </DialogTrigger>
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
