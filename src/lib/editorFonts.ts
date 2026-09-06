export type EditorFontCategory = "default" | "sans-serif" | "serif" | "monospace";

export type EditorFontOption = {
  id: string;
  label: string;
  category: EditorFontCategory;
  stack: string;
};

export const EDITOR_FONT_CATEGORIES: { id: EditorFontCategory; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "sans-serif", label: "Sans-serif" },
  { id: "serif", label: "Serif" },
  { id: "monospace", label: "Monospace" },
];

/** Curated fonts commonly pre-installed on Windows, macOS, and Linux. */
export const EDITOR_FONT_OPTIONS: EditorFontOption[] = [
  { id: "system", label: "System default", category: "default", stack: "" },

  { id: "segoe-ui", label: "Segoe UI", category: "sans-serif", stack: '"Segoe UI", system-ui, sans-serif' },
  { id: "inter", label: "Inter", category: "sans-serif", stack: 'Inter, "Segoe UI", system-ui, sans-serif' },
  { id: "arial", label: "Arial", category: "sans-serif", stack: "Arial, Helvetica, sans-serif" },
  {
    id: "helvetica",
    label: "Helvetica Neue",
    category: "sans-serif",
    stack: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  },
  { id: "verdana", label: "Verdana", category: "sans-serif", stack: "Verdana, Geneva, sans-serif" },
  { id: "tahoma", label: "Tahoma", category: "sans-serif", stack: "Tahoma, Geneva, sans-serif" },
  { id: "calibri", label: "Calibri", category: "sans-serif", stack: 'Calibri, "Segoe UI", sans-serif' },
  {
    id: "trebuchet",
    label: "Trebuchet MS",
    category: "sans-serif",
    stack: '"Trebuchet MS", sans-serif',
  },
  { id: "ubuntu", label: "Ubuntu", category: "sans-serif", stack: "Ubuntu, system-ui, sans-serif" },
  { id: "sans-serif", label: "Generic sans-serif", category: "sans-serif", stack: "sans-serif" },

  { id: "georgia", label: "Georgia", category: "serif", stack: 'Georgia, "Times New Roman", serif' },
  {
    id: "times",
    label: "Times New Roman",
    category: "serif",
    stack: '"Times New Roman", Times, serif',
  },
  { id: "cambria", label: "Cambria", category: "serif", stack: "Cambria, Georgia, serif" },
  {
    id: "palatino",
    label: "Palatino",
    category: "serif",
    stack: '"Palatino Linotype", Palatino, "Book Antiqua", serif',
  },
  { id: "garamond", label: "Garamond", category: "serif", stack: 'Garamond, "Times New Roman", serif' },
  { id: "constantia", label: "Constantia", category: "serif", stack: "Constantia, Georgia, serif" },
  { id: "serif", label: "Generic serif", category: "serif", stack: "serif" },

  {
    id: "consolas",
    label: "Consolas",
    category: "monospace",
    stack: 'Consolas, "Cascadia Mono", monospace',
  },
  {
    id: "cascadia-mono",
    label: "Cascadia Mono",
    category: "monospace",
    stack: '"Cascadia Mono", Consolas, monospace',
  },
  {
    id: "cascadia-code",
    label: "Cascadia Code",
    category: "monospace",
    stack: '"Cascadia Code", Consolas, monospace',
  },
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    category: "monospace",
    stack: '"JetBrains Mono", Consolas, monospace',
  },
  {
    id: "fira-code",
    label: "Fira Code",
    category: "monospace",
    stack: '"Fira Code", Consolas, monospace',
  },
  {
    id: "source-code-pro",
    label: "Source Code Pro",
    category: "monospace",
    stack: '"Source Code Pro", Consolas, monospace',
  },
  { id: "menlo", label: "Menlo", category: "monospace", stack: "Menlo, Monaco, Consolas, monospace" },
  {
    id: "courier",
    label: "Courier New",
    category: "monospace",
    stack: '"Courier New", Courier, monospace',
  },
  {
    id: "lucida-console",
    label: "Lucida Console",
    category: "monospace",
    stack: '"Lucida Console", Monaco, monospace',
  },
  { id: "monospace", label: "Generic monospace", category: "monospace", stack: "monospace" },
];

const FONT_BY_ID = new Map(EDITOR_FONT_OPTIONS.map((option) => [option.id, option]));

export type EditorFontId = (typeof EDITOR_FONT_OPTIONS)[number]["id"];

export function isEditorFontId(value: string): value is EditorFontId {
  return FONT_BY_ID.has(value);
}

export function getEditorFontOption(id: string): EditorFontOption | undefined {
  return FONT_BY_ID.get(id);
}

export function getEditorFontStack(id: string): string | undefined {
  const option = FONT_BY_ID.get(id);
  if (!option || !option.stack) return undefined;
  return option.stack;
}

export function applyEditorFontFamily(id: string): void {
  const root = document.documentElement;
  if (id === "system") {
    root.removeAttribute("data-editor-font");
    root.style.removeProperty("--editor-font-family");
    return;
  }

  const stack = getEditorFontStack(id) ?? id;
  root.setAttribute("data-editor-font", id);
  root.style.setProperty("--editor-font-family", stack);
}
