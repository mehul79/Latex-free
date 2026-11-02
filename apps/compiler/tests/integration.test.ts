import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { templates, type CompileEngine } from "@latex-free/shared";
import { Compiler, docker } from "../src/compiler.js";

const integration = process.env.COMPILER_INTEGRATION === "1" ? describe : describe.skip;
const simple = "\\documentclass{article}\n\\begin{document}\nHello from the sandbox.\n\\end{document}\n";
integration("real Docker TeX compilation", () => {
  for (const engine of ["pdflatex", "xelatex", "lualatex"] satisfies CompileEngine[]) {
    it(`compiles with ${engine} and returns PDF and SyncTeX`, async () => {
      const result = await new Compiler().compile({ files: [{ path: "main.tex", content: simple }], mainFile: "main.tex", engine });
      expect(result.status, result.log).toBe("succeeded");
      expect(Buffer.from(result.pdfBase64!, "base64").subarray(0, 5).toString()).toBe("%PDF-");
      expect(gunzipSync(Buffer.from(result.synctexBase64!, "base64")).toString()).toContain("SyncTeX Version:");
    });
  }

  for (const template of templates) {
    it(`compiles the ${template.id} starter`, async () => {
      const result = await new Compiler().compile({ files: [{ path: "main.tex", content: template.source }], mainFile: "main.tex", engine: "pdflatex" });
      expect(result.status, result.log).toBe("succeeded");
    });
  }

  it("preserves nested includes and maps errors to uploaded filenames", async () => {
    const result = await new Compiler().compile({ files: [{ path: "chapters/main.tex", content: "\\documentclass{article}\n\\begin{document}\n\\input{part}\n\\end{document}" }, { path: "chapters/part.tex", content: "\\undefinedCommand" }], mainFile: "chapters/main.tex", engine: "pdflatex" });
    expect(result.status).toBe("failed");
    expect(result.diagnostics.some((item) => item.severity === "error" && item.line && item.file === "chapters/part.tex"), result.log).toBe(true);
    expect(result.pdfBase64).toBeUndefined();
  });

  it("reads nested text and binary assets under a restrictive host umask", async () => {
    const mask = process.umask(0o077);
    try {
      const result = await new Compiler().compile({ files: [
        { path: "chapters/main.tex", content: "\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\input{part}\n\\includegraphics[width=1cm]{pixel.png}\n\\end{document}" },
        { path: "chapters/part.tex", content: "Included text." },
        { path: "chapters/pixel.png", encoding: "base64", content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" },
      ], mainFile: "chapters/main.tex", engine: "pdflatex" });
      expect(result.status, result.log).toBe("succeeded");
    } finally { process.umask(mask); }
  });

  it("ignores project latexmkrc and shell execution requests", async () => {
    const source = simple.replace("Hello from the sandbox.", "\\immediate\\write18{touch /work/shell-executed}\n\\IfFileExists{/work/shell-executed}{\\errmessage{SHELL_EXECUTED}}{Shell disabled}");
    const result = await new Compiler().compile({ files: [{ path: "main.tex", content: source }, { path: ".latexmkrc", content: 'die "UPLOADED_RC_EXECUTED";' }], mainFile: "main.tex", engine: "pdflatex" });
    expect(result.status, result.log).toBe("succeeded");
    expect(result.log).not.toContain("UPLOADED_RC_EXECUTED");
  });

  it("forbids reading arbitrary absolute container paths", async () => {
    const result = await new Compiler().compile({ files: [{ path: "main.tex", content: simple.replace("Hello from the sandbox.", "\\input{/etc/passwd}") }], mainFile: "main.tex", engine: "pdflatex" });
    expect(result.status).toBe("failed");
    expect(result.pdfBase64).toBeUndefined();
  });

  it("forbids writing arbitrary absolute container paths", async () => {
    const source = simple.replace("Hello from the sandbox.", "\\newwrite\\outside\\immediate\\openout\\outside=/tmp/outside.txt\\immediate\\write\\outside{outside}\\immediate\\closeout\\outside");
    const result = await new Compiler().compile({ files: [{ path: "main.tex", content: source }], mainFile: "main.tex", engine: "pdflatex" });
    expect(result.status, result.log).toBe("failed");
    expect(result.log).toContain("I can't write on file");
    expect(result.log).toContain("/tmp/outside.txt");
    expect(result.pdfBase64).toBeUndefined();
  });

  it("disables Lua process execution and network sockets", async () => {
    const guard = `
      if os.execute then pcall(os.execute, 'touch /work/lua-executed') end
      if io.popen then
        local ok, pipe = pcall(io.popen, 'touch /work/lua-popened')
        if ok and pipe then pipe:close() end
      end
      local fs = require('lfs')
      assert(not fs.attributes('/work/lua-executed'), 'os.execute ran a process')
      assert(not fs.attributes('/work/lua-popened'), 'io.popen ran a process')
      local loaded, socket = pcall(require, 'socket')
      if loaded and socket.tcp then
        local created, connection = pcall(socket.tcp)
        if created and connection then connection:close() end
        assert(not created or not connection, 'Lua created a network socket')
      end
    `.replace(/\s+/g, " ");
    const source = simple.replace("Hello from the sandbox.", `\\directlua{${guard}}Lua sandbox`);
    const result = await new Compiler().compile({ files: [{ path: "main.tex", content: source }], mainFile: "main.tex", engine: "lualatex" });
    expect(result.status, result.log).toBe("succeeded");
  });

  it("terminates a non-finishing compile within the deadline", async () => {
    const containers = async () => {
      const result = await docker(["ps", "--all", "--filter", "name=latex-free-", "--format", "{{.ID}}"], 5000);
      expect(result.code).toBe(0);
      return result.stdout.toString().trim().split("\n").filter(Boolean).sort();
    };
    const before = await containers();
    const result = await new Compiler(undefined, 2500).compile({ files: [{ path: "main.tex", content: "\\documentclass{article}\n\\begin{document}\n\\loop\\iftrue\\repeat\n\\end{document}" }], mainFile: "main.tex", engine: "pdflatex" });
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0].message).toContain("time limit");
    // Includes separately bounded Docker startup on vfs storage drivers.
    expect(result.durationMs).toBeLessThan(50_000);
    expect(await containers()).toEqual(before);
  });
});
