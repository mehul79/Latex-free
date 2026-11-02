import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Compiler, latexArguments, sandboxArguments } from "../src/compiler.js";
import { parseDiagnostics } from "../src/diagnostics.js";
import { createCompilerServer } from "../src/server.js";

describe("compiler security boundaries", () => {
  it("creates a resource-limited isolated container with read-only input", () => {
    const args = sandboxArguments("job", "/tmp/input", "/source", "latex-free-tex:local");
    for (const flag of ["--network=none", "--read-only", "--user=10001:10001", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=512m", "--cpus=1", "--env=openin_any=p", "--env=openout_any=p"]) expect(args).toContain(flag);
    expect(args).toContain("type=bind,source=/tmp/input,target=/source,readonly");
  });

  it("ignores uploaded latexmk configuration and disables shell and Lua sockets", () => {
    for (const engine of ["pdflatex", "xelatex", "lualatex"] as const) {
      const args = latexArguments(engine, "main.tex");
      expect(args).toContain("-norc");
      expect(args.join(" ")).toContain("no-shell-escape");
      if (engine === "lualatex") expect(args.join(" ")).toContain("--safer --nosocket");
    }
  });

  it("reports file/line diagnostics using the original main filename", () => {
    expect(parseDiagnostics("./compile-entry.tex:4: Undefined control sequence.\nLaTeX Warning: Reference undefined", "chapters/main.tex", "compile-entry.tex")).toEqual([
      { severity: "error", file: "chapters/main.tex", line: 4, message: "Undefined control sequence." },
      { severity: "warning", message: "LaTeX Warning: Reference undefined" },
    ]);
  });

  it("resolves included-file diagnostics relative to the nested main file", () => {
    expect(parseDiagnostics("./part.tex:1: Undefined control sequence.\n/source/shared.tex:2: Missing number.", "chapters/main.tex")).toEqual([
      { severity: "error", file: "chapters/part.tex", line: 1, message: "Undefined control sequence." },
      { severity: "error", file: "shared.tex", line: 2, message: "Missing number." },
    ]);
  });

  it("rejects invalid snapshots before invoking Docker", async () => {
    const compiler = new Compiler();
    await expect(compiler.compile({ mainFile: "../main.tex", engine: "pdflatex", files: [{ path: "../main.tex", content: "hello" }] })).rejects.toThrow();
    await expect(compiler.compile({ mainFile: "main.tex", engine: "pdflatex", files: [{ path: "main.tex", content: "a".repeat(1_000_001) }] })).rejects.toThrow();
  });
});

describe("worker HTTP authorization", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => { server!.closeAllConnections(); server!.close(() => resolve()); });
  });
  it("requires the worker token and rejects malformed projects", async () => {
    const token = "a".repeat(32);
    server = createCompilerServer(token);
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/compile`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${url}/compile`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ files: [], engine: "pdflatex", mainFile: "main.tex" }) })).status).toBe(400);
  });
});
