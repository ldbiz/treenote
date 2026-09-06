import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyInitialTheme } from "./hooks/useTheme";
import { applyInitialEditorFont } from "./hooks/useEditorFont";
import { applyInitialUiZoom } from "./hooks/useUiZoom";
import { applyProductionWebviewGuards } from "./lib/devMode";

applyInitialTheme();
applyInitialEditorFont();
applyInitialUiZoom();
void applyProductionWebviewGuards();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
