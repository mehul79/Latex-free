import { describe, it, expect } from "vitest";
import {
  createProjectSchema,
  createFileSchema,
  updateFileSchema,
  initialFiles,
  templateIds,
} from "../src/index.js";
describe("project inputs", () => {
  it("rejects empty names and unknown templates", () => {
    expect(createProjectSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(
      createProjectSchema.safeParse({ name: "Test", template: "unknown" })
        .success,
    ).toBe(false);
  });
  it("rejects traversal, absolute paths, and invalid segments", () => {
    for (const path of [
      "../secret",
      "/etc/passwd",
      "a/../b",
      "a\\b",
      "a//b",
      "./a",
      "a\0.tex",
    ]) {
      expect(createFileSchema.safeParse({ path }).success, path).toBe(false);
    }
    expect(
      createFileSchema.safeParse({ path: "sections/intro.tex" }).success,
    ).toBe(true);
  });
  it("requires an optimistic version for saves", () => {
    expect(updateFileSchema.safeParse({ content: "new" }).success).toBe(false);
    expect(
      updateFileSchema.safeParse({ content: "new", version: 0 }).success,
    ).toBe(true);
  });
  it("provides a complete document for every starter", () => {
    for (const template of templateIds) {
      const [file] = initialFiles(template);
      expect(file.path).toBe("main.tex");
      expect(file.content).toContain("\\begin{document}");
      expect(file.content).toContain("\\end{document}");
    }
  });
});
