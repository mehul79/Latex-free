import { randomUUID } from "node:crypto";
import { compileRequestSchema, compileResultSchema } from "@latex-free/shared";
import type { ProjectService } from "../project-service.js";
import { ApiError } from "../document-service.js";
import type { CompileDiagnostics } from "./contracts.js";

export class McpCompileService {
  private runs = new Map<
    string,
    {
      actorId: string;
      projectId: string;
      expires: number;
      result: CompileDiagnostics;
    }
  >();
  private active = 0;
  private lastStarts = new Map<string, number[]>();
  constructor(
    private projects: ProjectService,
    private config: { COMPILER_URL?: string; COMPILER_TOKEN?: string },
    private request: typeof fetch = fetch,
  ) {}
  async compile(
    actorId: string,
    projectId: string,
    input: { mainFile: string; engine: "pdflatex" | "xelatex" | "lualatex" },
  ) {
    // Snapshot authorization happens before compiler configuration/availability disclosure.
    const snapshot = await this.projects.compileSnapshot(actorId, projectId);
    const body = compileRequestSchema.parse({
      files: snapshot.files,
      ...input,
    });
    if (!this.config.COMPILER_URL || !this.config.COMPILER_TOKEN)
      throw new ApiError(503, "Compiler is not configured");
    const now = Date.now();
    this.prune(now);
    const starts = (this.lastStarts.get(actorId) ?? []).filter(
      (time) => time > now - 60_000,
    );
    if (this.active >= 2 || starts.length >= 10)
      throw new ApiError(429, "Compiler is busy");
    starts.push(now);
    this.lastStarts.set(actorId, starts);
    this.active++;
    try {
      const response = await this.request(
        new URL("/compile", this.config.COMPILER_URL),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.COMPILER_TOKEN}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90_000),
        },
      );
      if (!response.ok)
        throw new ApiError(
          response.status === 429 ? 429 : 503,
          "Compiler is unavailable",
        );
      const reader = response.body?.getReader();
      if (!reader) throw new ApiError(503, "Empty compiler response");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 60 * 1024 * 1024) {
          await reader.cancel();
          throw new ApiError(503, "Compiler response exceeds limit");
        }
        chunks.push(value);
      }
      const parsed = compileResultSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      const result: CompileDiagnostics = {
        runId: randomUUID(),
        success: parsed.status === "succeeded",
        errors: parsed.diagnostics
          .slice(0, 100)
          .map((d) => ({
            ...d,
            message: d.message.slice(0, 2000),
            ...(d.file ? { file: d.file.slice(0, 500) } : {}),
          })),
        versions: snapshot.versions,
      };
      // Logs, binary assets, and PDF bytes are deliberately never retained in the diagnostic cache.
      this.runs.set(result.runId, {
        actorId,
        projectId,
        expires: Date.now() + 15 * 60_000,
        result,
      });
      this.prune(Date.now());
      return result;
    } finally {
      this.active--;
    }
  }
  async getCompileErrors(actorId: string, projectId: string, runId: string) {
    if (!(await this.projects.role(actorId, projectId)))
      throw new ApiError(404, "Project not found");
    this.prune(Date.now());
    const run = this.runs.get(runId);
    if (!run || run.actorId !== actorId || run.projectId !== projectId)
      throw new ApiError(404, "Compile run not found or expired");
    const current = await this.projects.compileSnapshot(actorId, projectId);
    const stale =
      JSON.stringify(Object.entries(run.result.versions).sort()) !==
      JSON.stringify(Object.entries(current.versions).sort());
    return { ...run.result, stale, currentVersions: current.versions };
  }
  private prune(now: number) {
    for (const [id, run] of this.runs)
      if (run.expires <= now) this.runs.delete(id);
    while (this.runs.size > 100)
      this.runs.delete(this.runs.keys().next().value!);
    for (const [actor, starts] of this.lastStarts) {
      const recent = starts.filter((time) => time > now - 60_000);
      if (!recent.length) this.lastStarts.delete(actor);
      else this.lastStarts.set(actor, recent);
    }
  }
}
