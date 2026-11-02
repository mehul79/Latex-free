import { describe, expect, it } from "vitest";
import { analyzeResume } from "../src/resume/index.js";
describe("resume source heuristics", () => {
  it("reports source evidence and explicitly limits claims", () => {
    const result = analyzeResume(
      "\\begin{tabular}{ll}\n\\begin{multicols}{2}\n\\includegraphics{resume.png}\n\\section{Experience}\n\\item " +
        "word ".repeat(41),
    );
    expect(result.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining([
        "TABLE_LAYOUT",
        "MULTICOLUMN_LAYOUT",
        "IMAGE_CONTENT",
        "MISSING_CONTACT",
        "LONG_BULLET",
      ]),
    );
    expect(
      result.warnings.find((w) => w.code === "TABLE_LAYOUT")?.evidence,
    ).toEqual([{ line: 1, text: "\\begin{tabular}{ll}" }]);
    expect(result.sections[0]).toMatchObject({ title: "Experience", line: 4 });
    expect(result.bullets[0].wordCount).toBe(41);
    expect(result.disclaimer).toContain(
      "does not guarantee ATS compatibility or one-page fit",
    );
  });
  it("ignores comments and detects contact and ordinary sections", () => {
    const result = analyzeResume(
      "% \\begin{tabular}{ll}\n\\section*{Education}\nada@example.com\n\\begin{itemize}\n\\item Wrote a parser.\n\\end{itemize}",
    );
    expect(result.warnings).toEqual([]);
    expect(result.bullets[0].wordCount).toBe(3);
  });
  it("counts multiline bullets separately", () => {
    const result = analyzeResume(
      "\\item First line\nsecond line\n\\item Another bullet \\item Last bullet\n\\end{itemize}",
    );
    expect(result.bullets.map((b) => b.wordCount)).toEqual([4, 2, 2]);
  });
  it("handles empty input without inventing evidence", () => {
    const result = analyzeResume("");
    expect(result.sections).toEqual([]);
    expect(result.bullets).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.every((w) => w.evidence.length === 0)).toBe(true);
  });
  it("bounds source size", () => {
    expect(() => analyzeResume("x".repeat(1024 * 1024 + 1))).toThrow(
      RangeError,
    );
  });
});
