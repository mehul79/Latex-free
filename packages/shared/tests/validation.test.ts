import { describe, it, expect } from "vitest";
import {
  createProjectSchema,
  createFileSchema,
  updateFileSchema,
  initialFiles,
  templateIds,
  importProjectSchema,
  MAX_FILE_BYTES,
  compileRequestSchema,
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

describe("assets, imports and compile inputs", () => {
  it("accepts canonical binary data and rejects malformed base64", () => {
    for (const content of ["", "AA==", "AQI=", "AQID"])
      expect(
        createFileSchema.safeParse({
          path: "image.png",
          content,
          encoding: "base64",
        }).success,
      ).toBe(true);
    for (const content of ["AAA", "AB==", "AAB=", "%%%", "AA==\n"])
      expect(
        createFileSchema.safeParse({
          path: "image.png",
          content,
          encoding: "base64",
        }).success,
      ).toBe(false);
  });
  it("validates a maximum-size binary asset without exhausting the regex stack", () => {
    expect(
      createFileSchema.safeParse({
        path: "asset.bin",
        encoding: "base64",
        content: Buffer.alloc(MAX_FILE_BYTES).toString("base64"),
      }).success,
    ).toBe(true);
  });
  it("rejects Windows paths, control characters and ambiguous whitespace", () => {
    for (const path of [
      "C:/secret",
      "C:secret",
      "a\x7f",
      "a\n",
      " main.tex",
      "dir /a",
    ])
      expect(createFileSchema.safeParse({ path }).success).toBe(false);
  });
  it("rejects duplicates and parent file collisions in imports", () => {
    for (const paths of [
      ["a", "a"],
      ["a", "a-b", "a/c"],
    ])
      expect(
        importProjectSchema.safeParse({
          name: "test",
          files: paths.map((path) => ({ path })),
        }).success,
      ).toBe(false);
    expect(
      importProjectSchema.safeParse({
        name: "test",
        files: [
          { path: "main.tex" },
          { path: "img/p.png", content: "AA==", encoding: "base64" },
        ],
      }).success,
    ).toBe(true);
  });
  it("requires a real text main file and a supported engine", () => {
    const input = {
      files: [{ path: "main.tex", content: "hello" }],
      mainFile: "main.tex",
      engine: "pdflatex",
    };
    expect(compileRequestSchema.safeParse(input).success).toBe(true);
    expect(
      compileRequestSchema.safeParse({ ...input, mainFile: "missing.tex" })
        .success,
    ).toBe(false);
    expect(
      compileRequestSchema.safeParse({ ...input, engine: "shell" }).success,
    ).toBe(false);
  });
});
