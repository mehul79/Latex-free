export interface ResumeEvidence {
  line: number;
  text: string;
}
export interface ResumeWarning {
  code:
    | "TABLE_LAYOUT"
    | "MULTICOLUMN_LAYOUT"
    | "IMAGE_CONTENT"
    | "MISSING_CONTACT"
    | "MISSING_SECTIONS"
    | "LONG_BULLET";
  message: string;
  evidence: ResumeEvidence[];
}
export interface ResumeAnalysis {
  kind: "source-heuristic";
  disclaimer: string;
  warnings: ResumeWarning[];
  sections: Array<ResumeEvidence & { title: string }>;
  bullets: Array<ResumeEvidence & { wordCount: number }>;
}
function withoutComment(line: string): string {
  for (let index = 0; index < line.length; index++) {
    if (line[index] !== "%") continue;
    let precedingSlashes = 0;
    for (
      let previous = index - 1;
      previous >= 0 && line[previous] === "\\";
      previous--
    )
      precedingSlashes++;
    if (precedingSlashes % 2 === 0) return line.slice(0, index);
  }
  return line;
}
/** Static source hints only: does not inspect compiled PDFs or infer applicant facts. */
export function analyzeResume(source: string): ResumeAnalysis {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source, "utf8") > 1024 * 1024
  )
    throw new RangeError("Resume source must be text no larger than 1 MiB.");
  const lines = source.split(/\r?\n/).map(withoutComment);
  const evidence = (index: number): ResumeEvidence => ({
    line: index + 1,
    text: lines[index].trim().slice(0, 300),
  });
  const warnings: ResumeWarning[] = [];
  const detect = (pattern: RegExp) =>
    lines.flatMap((line, index) =>
      pattern.test(line) ? [evidence(index)] : [],
    );
  const tables = detect(
    /\\begin\s*\{(?:tabular\*?|tabularx|longtable|table\*?)\}/,
  );
  if (tables.length)
    warnings.push({
      code: "TABLE_LAYOUT",
      message:
        "Tables may disrupt text reading order in some applicant tracking systems. Check the compiled PDF text.",
      evidence: tables,
    });
  const columns = detect(
    /\\(?:begin\s*\{(?:multicols\*?|paracol)\}|twocolumn\b|documentclass\s*\[[^\]]*\btwocolumn\b)/,
  );
  if (columns.length)
    warnings.push({
      code: "MULTICOLUMN_LAYOUT",
      message:
        "Multiple columns may affect text reading order in some applicant tracking systems.",
      evidence: columns,
    });
  const images = detect(/\\(?:includegraphics\*?|includepdf)\b/);
  if (images.length)
    warnings.push({
      code: "IMAGE_CONTENT",
      message:
        "Included images or PDFs may contain text that cannot be extracted. Keep essential resume information as selectable text.",
      evidence: images,
    });
  const visible = lines.join("\n");
  const hasEmail = /[A-Z0-9.!#$&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(
    visible,
  );
  const hasPhone = /(?:\+?\d[\d\s().-]{5,}\d)/.test(visible);
  if (!hasEmail && !hasPhone)
    warnings.push({
      code: "MISSING_CONTACT",
      message:
        "No recognizable email address or phone number was found in the source. Custom macros or included files may hide contact information from this check.",
      evidence: [],
    });
  const sections = lines.flatMap((line, index) =>
    [
      ...line.matchAll(
        /\\(?:section|subsection)\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g,
      ),
    ].map((match) => ({ ...evidence(index), title: match[1] })),
  );
  if (!sections.length)
    warnings.push({
      code: "MISSING_SECTIONS",
      message:
        "No standard section headings were detected. Custom heading macros are not recognized by this source check.",
      evidence: [],
    });
  const bullets: ResumeAnalysis["bullets"] = [];
  for (let index = 0; index < lines.length; index++) {
    const matches = [...lines[index].matchAll(/\\item\b(?:\s*\[[^\]]*\])?/g)];
    for (let itemIndex = 0; itemIndex < matches.length; itemIndex++) {
      const match = matches[itemIndex];
      const start = match.index! + match[0].length;
      let content = lines[index].slice(start, matches[itemIndex + 1]?.index);
      if (itemIndex === matches.length - 1) {
        for (let next = index + 1; next < lines.length; next++) {
          if (
            /\\(?:item\b|end\s*\{(?:itemize|enumerate|description)\}|(?:sub)?section\b)/.test(
              lines[next],
            )
          )
            break;
          content += ` ${lines[next]}`;
        }
      }
      content = content.split(
        /\\end\s*\{(?:itemize|enumerate|description)\}/,
      )[0];
      const plain = content
        .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, " ")
        .replace(/[{}]/g, " ");
      const wordCount =
        plain.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
      const bullet = { ...evidence(index), wordCount };
      bullets.push(bullet);
      if (wordCount > 40)
        warnings.push({
          code: "LONG_BULLET",
          message: `This bullet has approximately ${wordCount} words. Consider shortening it for easier scanning.`,
          evidence: [bullet],
        });
    }
  }
  return {
    kind: "source-heuristic",
    disclaimer:
      "Heuristic source checks only; this is not an ATS scan and does not guarantee ATS compatibility or one-page fit. Compile and review the PDF and its extracted text.",
    warnings,
    sections,
    bullets,
  };
}
