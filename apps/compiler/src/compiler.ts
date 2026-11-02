import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { tmpdir } from "node:os";
import { compileRequestSchema, type CompileEngine, type CompileRequest, type CompileResult } from "@latex-free/shared";
import { parseDiagnostics } from "./diagnostics.js";

const MAX_LOG = 1024 * 1024;
const MAX_PDF = 15 * 1024 * 1024;
const MAX_SYNCTEX = 5 * 1024 * 1024;
const MAX_DURATION = 30_000;
export class WorkerBusyError extends Error {}
type CommandResult = { code: number; stdout: Buffer; stderr: Buffer };

// Explicit local socket and cleared selectors prevent inherited context settings
// from redirecting sandbox creation to a different Docker host.
const dockerEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"].includes(key),
));
export function docker(args: string[], timeout: number, maxBytes = MAX_LOG): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["--host=unix:///var/run/docker.sock", ...args], {
      env: dockerEnvironment, stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, failure: Error | undefined;
    const abort = (message: string) => {
      failure ??= new Error(message);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => abort("Compilation exceeded its time limit"), Math.max(1, timeout));
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) abort("Compiler output exceeded its size limit");
      else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

export function sandboxArguments(name: string, source: string, workdir: string, image: string): string[] {
  return [
    "run", "--detach", "--name", name, "--network=none", "--read-only", "--user=10001:10001",
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=512m",
    "--memory-swap=512m", "--cpus=1", "--ulimit=nofile=128:128", "--ulimit=fsize=33554432:33554432",
    "--mount", `type=bind,source=${source},target=/source,readonly`,
    "--tmpfs", "/work:rw,noexec,nosuid,nodev,size=128m,uid=10001,gid=10001,mode=0700",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700",
    "--workdir", workdir,
    "--env=HOME=/tmp", "--env=TEXMFVAR=/tmp/texmf-var", "--env=TEXMFCONFIG=/tmp/texmf-config",
    "--env=TEXMFOUTPUT=/work", "--env=openin_any=p", "--env=openout_any=p", "--env=shell_escape=0",
    "--env=HTTP_PROXY=", "--env=HTTPS_PROXY=", "--env=ALL_PROXY=", "--env=http_proxy=", "--env=https_proxy=",
    "--entrypoint=/bin/sleep", image, "60",
  ];
}

export function latexArguments(engine: CompileEngine, entry: string): string[] {
  const engines: Record<CompileEngine, string[]> = {
    pdflatex: ["-pdf", "-pdflatex=pdflatex -no-shell-escape %O %S"],
    xelatex: ["-pdfxe", "-xelatex=xelatex -no-shell-escape %O %S"],
    lualatex: ["-pdflua", "-lualatex=lualatex --safer --nosocket --no-shell-escape %O %S"],
  };
  return ["latexmk", "-norc", ...engines[engine], "-interaction=nonstopmode", "-halt-on-error",
    "-file-line-error", "-synctex=1", "-outdir=/work", "-jobname=document", `./${entry}`];
}

// The file is opened inside the sandbox, without following symlinks. No archive
// from an untrusted job is ever extracted onto the worker host.
const READ_ARTIFACT = "my ($p,$max)=@ARGV; my @s=lstat($p); exit 3 unless @s && -f _ && !-l _ && $s[7] <= $max; sysopen(my $f,$p,O_RDONLY|O_NOFOLLOW) or exit 3; binmode($f); binmode(STDOUT); my $n=0; while(my $r=sysread($f,my $b,65536)){ $n+=$r; exit 3 if $n>$max; print $b; }";

export class Compiler {
  private active = 0;
  constructor(private readonly image = process.env.TEX_IMAGE || "latex-free-tex:local", private readonly timeout = MAX_DURATION) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9./:@_-]+$/.test(image)) throw new Error("Invalid configured TeX image");
    if (timeout <= 0 || timeout > MAX_DURATION) throw new Error("Invalid compiler timeout");
  }

  async compile(input: CompileRequest): Promise<CompileResult> {
    const request = compileRequestSchema.parse(input);
    if (this.active >= 2) throw new WorkerBusyError("Compiler is busy");
    this.active++;
    const started = Date.now();
    let executionStarted = started;
    const remaining = () => Math.max(1, this.timeout - (Date.now() - executionStarted));
    const name = `latex-free-${randomUUID()}`;
    let snapshot: string | undefined;
    let log = "";
    const entry = `compile-${randomUUID()}.tex`;
    try {
      snapshot = await mkdtemp(join(process.env.COMPILER_TMPDIR || tmpdir(), "latex-free-"));
      if (snapshot.includes(",")) throw new Error("Compiler temporary directory cannot contain a comma");
      await chmod(snapshot, 0o755);
      const directories = new Set<string>();
      for (const file of request.files) {
        const target = join(snapshot, file.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        // Explicit chmod is necessary when a deployment starts the worker with
        // umask 0077; mkdir/writeFile modes alone would make uploads unreadable
        // to the sandbox's separate UID.
        let directory = dirname(target);
        while (directory !== snapshot && !directories.has(directory)) {
          await chmod(directory, 0o755);
          directories.add(directory);
          directory = dirname(directory);
        }
        await writeFile(target, Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8"), { flag: "wx", mode: 0o444 });
        await chmod(target, 0o444);
      }
      const mainDirectory = posix.dirname(request.mainFile);
      // A random, worker-controlled basename keeps latexmk's shell command
      // construction independent of uploaded filenames, including quote syntax.
      await copyFile(join(snapshot, request.mainFile), join(snapshot, mainDirectory, entry));
      await chmod(join(snapshot, mainDirectory, entry), 0o444);
      // Docker's vfs storage driver can spend tens of seconds constructing a
      // fresh root filesystem. Bound startup separately from TeX execution.
      const created = await docker(sandboxArguments(name, snapshot, posix.join("/source", mainDirectory), this.image), 45_000);
      if (created.code !== 0) throw new Error("Compiler sandbox could not start. Check the TeX image and Docker daemon.");
      executionStarted = Date.now();
      const compiled = await docker(["exec", name, ...latexArguments(request.engine, entry)], remaining());
      log = Buffer.concat([compiled.stdout, compiled.stderr]).toString("utf8").slice(0, MAX_LOG);
      const readArtifact = async (path: string, maxBytes: number) => {
        const result = await docker(["exec", name, "perl", "-MFcntl=:DEFAULT", "-e", READ_ARTIFACT, path, String(maxBytes)], remaining(), maxBytes + 4096);
        return result.code === 0 ? result.stdout : undefined;
      };
      const texLog = await readArtifact("/work/document.log", MAX_LOG);
      if (texLog) log = texLog.toString("utf8").slice(0, MAX_LOG);
      const diagnostics = parseDiagnostics(log, request.mainFile, entry);
      if (compiled.code !== 0) {
        if (!diagnostics.some((item) => item.severity === "error")) diagnostics.push({ severity: "error", message: "TeX compilation failed. See the compiler log." });
        return { status: "failed", log, diagnostics, durationMs: Date.now() - started };
      }
      const pdf = await readArtifact("/work/document.pdf", MAX_PDF);
      if (!pdf || !pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Compiler did not produce a valid PDF within the output limit");
      const synctex = await readArtifact("/work/document.synctex.gz", MAX_SYNCTEX);
      return { status: "succeeded", pdfBase64: pdf.toString("base64"), ...(synctex && { synctexBase64: synctex.toString("base64") }), log, diagnostics, durationMs: Date.now() - started };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Compilation failed";
      return { status: "failed", log: `${log}\n${message}`.slice(-MAX_LOG), diagnostics: [{ severity: "error", message }], durationMs: Date.now() - started };
    } finally {
      // Removing the container also terminates descendants when the Docker CLI
      // timed out; killing only the CLI would leave the TeX process running.
      await docker(["rm", "--force", name], 5000).catch(() => undefined);
      if (snapshot) await rm(snapshot, { recursive: true, force: true });
      this.active--;
    }
  }
}
