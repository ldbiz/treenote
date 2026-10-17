const DARK_BACKGROUND = { red: 28, green: 25, blue: 23, alpha: 255 };
const LIGHT_BACKGROUND = { red: 255, green: 255, blue: 255, alpha: 255 };

function resolvedTheme(): "light" | "dark" {
  try {
    const stored = localStorage.getItem("treenote-theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage unavailable
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The archive review is a single resizable workspace, not a Settings panel. */
export async function openHousekeepingReviewWindow(): Promise<void> {
  const url = "housekeeping.html";
  const theme = resolvedTheme();

  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const existing = await WebviewWindow.getByLabel("housekeeping-review");
    if (existing) {
      await existing.show();
      await existing.unminimize();
      await existing.setFocus();
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const win = new WebviewWindow("housekeeping-review", {
        url,
        title: "TreeNote — Archive review",
        width: 1040,
        height: 760,
        minWidth: 780,
        minHeight: 550,
        center: true,
        resizable: true,
        visible: false,
        theme,
        backgroundColor: theme === "dark" ? DARK_BACKGROUND : LIGHT_BACKGROUND,
      });
      void win.once("tauri://created", () => resolve());
      void win.once("tauri://error", (event) =>
        reject(new Error(String(event.payload ?? "Failed to create archive review window"))),
      );
    });
    return;
  } catch (error) {
    // A normal browser preview can still open the dedicated review page.
    if ("__TAURI_INTERNALS__" in window) {
      throw error;
    }
  }

  const fallback = window.open(
    "/housekeeping.html",
    "treenote-housekeeping-review",
    "width=1040,height=760,menubar=no,toolbar=no",
  );
  if (!fallback) throw new Error("The review window was blocked.");
  fallback.focus();
}
