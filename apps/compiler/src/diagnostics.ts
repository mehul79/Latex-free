import type { CompileDiagnostic } from "@latex-free/shared";
import { posix } from "node:path";

export function parseDiagnostics(log: string, mainFile: string, entryFile?: string): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const normalize = (file: string) => {
    const path = file.replace(/^\.\//, "");
    if (entryFile && (path === entryFile || path.endsWith(`/${entryFile}`))) return mainFile;
    if (path.startsWith("/source/")) return path.slice("/source/".length);
    return posix.isAbsolute(path) ? path : posix.normalize(posix.join(posix.dirname(mainFile), path));
  };
  for (const line of log.split(/\r?\n/)) {
    const location = line.match(/^(.+?\.(?:tex|sty|cls)):(\d+):\s*(.+)$/);
    if (location) {
      diagnostics.push({ severity: "error", file: normalize(location[1]), line: Number(location[2]), message: location[3].slice(0, 10000) });
    } else if (line.startsWith("! ")) {
      diagnostics.push({ severity: "error", message: line.slice(2, 10002), file: mainFile });
    } else if (/^(?:LaTeX|Package .+|Class .+) Warning:|^Overfull |^Underfull /.test(line)) {
      diagnostics.push({ severity: "warning", message: line.slice(0, 10000) });
    }
    if (diagnostics.length === 2000) break;
  }
  return diagnostics;
}
