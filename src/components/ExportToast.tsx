import { useEffect, useState } from "react";

type ExportToastProps = {
  message: string;
  onDismiss: () => void;
  durationMs?: number;
};

export default function ExportToast({
  message,
  onDismiss,
  durationMs = 8000,
}: ExportToastProps) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const fadeTimer = window.setTimeout(() => setVisible(false), durationMs - 500);
    const dismissTimer = window.setTimeout(onDismiss, durationMs);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(dismissTimer);
    };
  }, [durationMs, onDismiss]);

  return (
    <div
      className={`export-toast${visible ? " export-toast-visible" : " export-toast-fading"}`}
      role="status"
      aria-live="polite"
    >
      <span className="export-toast-message">{message}</span>
      <button
        type="button"
        className="export-toast-dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
