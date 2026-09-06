import { describe, expect, it } from "vitest";
import { joinExportPath } from "./exportPath";

describe("joinExportPath", () => {
  it("joins Windows-style export folders with backslashes", () => {
    expect(joinExportPath("C:\\Users\\me\\AppData\\treenote\\exports", "notes.json")).toBe(
      "C:\\Users\\me\\AppData\\treenote\\exports\\notes.json",
    );
  });

  it("joins POSIX export folders with forward slashes", () => {
    expect(joinExportPath("/home/me/.local/share/treenote/exports", "notes.json")).toBe(
      "/home/me/.local/share/treenote/exports/notes.json",
    );
  });

  it("returns the file name when the export folder is empty", () => {
    expect(joinExportPath("", "notes.json")).toBe("notes.json");
  });
});
