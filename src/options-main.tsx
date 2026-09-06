import React, { useEffect, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import OptionsApp from "./OptionsApp";
import { applyInitialTheme } from "./hooks/useTheme";
import { applyInitialEditorFont } from "./hooks/useEditorFont";
import { applyInitialUiZoom } from "./hooks/useUiZoom";
import { applyProductionWebviewGuards } from "./lib/devMode";

async function revealOptionsWindow(): Promise<void> {
  try {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const win = getCurrentWebviewWindow();
    await win.show();
    await win.unminimize();
    await win.setFocus();
  } catch {
    // Browser preview or Tauri API unavailable
  }
}

function RevealOnPaint({ children }: { children: ReactNode }) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void revealOptionsWindow();
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
      <OptionsApp />
    </RevealOnPaint>
  </React.StrictMode>,
);
