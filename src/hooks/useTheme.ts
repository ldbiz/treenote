import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "treenote-theme";

function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // localStorage unavailable (e.g. private browsing)
  }
  return "system";
}

function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean
): "light" | "dark" {
  if (preference === "system") {
    return systemDark ? "dark" : "light";
  }
  return preference;
}

async function syncTauriTheme(preference: ThemePreference): Promise<void> {
  const theme = preference === "system" ? null : preference;

  try {
    const [{ setTheme: setAppTheme }, { getCurrentWebviewWindow }] =
      await Promise.all([
        import("@tauri-apps/api/app"),
        import("@tauri-apps/api/webviewWindow"),
      ]);

    await Promise.all([
      setAppTheme(theme),
      getCurrentWebviewWindow().setTheme(theme),
    ]);
  } catch {
    // Browser preview or Tauri API unavailable
  }
}

function applyDocumentTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", preference);
  }
}

export function applyInitialTheme(): void {
  applyDocumentTheme(readStoredPreference());
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(
    readStoredPreference
  );
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  const resolvedTheme = resolveTheme(preference, systemDark);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) =>
      setSystemDark(event.matches);
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      if (
        event.newValue === "light" ||
        event.newValue === "dark" ||
        event.newValue === "system"
      ) {
        setPreference(event.newValue);
      }
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    applyDocumentTheme(preference);
  }, [preference]);

  useEffect(() => {
    void syncTauriTheme(preference);
  }, [preference]);

  const setThemePreference = useCallback((next: ThemePreference) => {
    setPreference(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  }, []);

  const cycleTheme = useCallback(() => {
    setThemePreference(
      preference === "system" ? "light" : preference === "light" ? "dark" : "system"
    );
  }, [preference, setThemePreference]);

  return {
    preference,
    resolvedTheme,
    cycleTheme,
    setThemePreference,
  };
}
