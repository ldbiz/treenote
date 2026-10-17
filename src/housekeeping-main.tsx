import React, { useEffect, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import HousekeepingReviewApp from "./HousekeepingReviewApp";
import { applyInitialTheme } from "./hooks/useTheme";
import { applyInitialEditorFont } from "./hooks/useEditorFont";
import { applyInitialUiZoom } from "./hooks/useUiZoom";
import { applyProductionWebviewGuards } from "./lib/devMode";

function RevealOnPaint({ children }: { children: ReactNode }) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void (async () => {
          try {
            const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
            const win = getCurrentWebviewWindow();
            await win.show();
            await win.unminimize();
            await win.setFocus();
          } catch {
            // Browser preview or Tauri API unavailable
          }
        })();
      });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return children;
}

applyInitialTheme();
applyInitialEditorFont();
applyInitialUiZoom();
void applyProductionWebviewGuards();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RevealOnPaint>
      <HousekeepingReviewApp />
    </RevealOnPaint>
  </React.StrictMode>,
);
