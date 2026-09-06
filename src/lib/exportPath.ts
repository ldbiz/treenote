/** Join an export folder and file name using a platform-appropriate separator. */
export function joinExportPath(exportFolder: string, fileName: string): string {
  const trimmed = exportFolder.replace(/[\\/]+$/, "");
  if (!trimmed) return fileName;
  const separator = exportPathSeparator(trimmed);
  return `${trimmed}${separator}${fileName}`;
}

function exportPathSeparator(exportFolder: string): string {
  if (exportFolder.includes("\\")) {
    return "\\";
  }
  if (/^[A-Za-z]:/.test(exportFolder)) {
    return "\\";
  }
  return "/";
}
