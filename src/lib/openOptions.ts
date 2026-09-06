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

export async function openOptionsWindow(section?: string): Promise<void> {
  const hash = section ? `#${section}` : "";
  const url = `options.html${hash}`;
  const theme = resolvedTheme();

  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const existing = await WebviewWindow.getByLabel("options");
    if (existing) {
      await existing.show();
      await existing.unminimize();
      await existing.setFocus();
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const win = new WebviewWindow("options", {
        url,
        title: "Tree Note Options",
        width: 520,
        height: 680,
        minWidth: 440,
        minHeight: 520,
        center: true,
        resizable: true,
        visible: false,
        theme,
        backgroundColor: theme === "dark" ? DARK_BACKGROUND : LIGHT_BACKGROUND,
      });
      void win.once("tauri://created", () => resolve());
      void win.once("tauri://error", (event) => {
        reject(new Error(String(event.payload ?? "Failed to create options window")));
      });
    });
    return;
  } catch (error) {
    console.error("Failed to open options window:", error);
  }

  window.open(
    `/options.html${hash}`,
    "treenote-options",
    "width=520,height=680,menubar=no,toolbar=no",
  );
}
