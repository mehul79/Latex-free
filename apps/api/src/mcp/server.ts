import express from "express";
import { rateLimit } from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { filePathSchema } from "@latex-free/shared";
import type {
  AccessTokenRecord,
  McpDomain,
  TokenScope,
  TokenStore,
} from "./contracts.js";
import { authenticateToken } from "./tokens.js";

const id = z.string().min(1).max(128);
const version = z.number().int().nonnegative();
const text = z.string().max(500_000);
const project = { projectId: id };
const file = { ...project, fileId: id };
const write = { ...file, expectedVersion: version };
const schemas = {
  list_projects: z.object({}).strict(),
  list_files: z.object(project).strict(),
  read_file: z.object(file).strict(),
  create_file: z
    .object({ ...project, path: filePathSchema, content: text })
    .strict(),
  edit_file: z
    .object({
      ...write,
      find: text.min(1),
      replace: text,
      expectedMatches: z.number().int().min(1).max(10_000),
    })
    .strict(),
  write_file: z.object({ ...write, content: text }).strict(),
  delete_file: z.object(write).strict(),
  compile: z
    .object({
      ...project,
      mainFile: filePathSchema,
      engine: z.enum(["pdflatex", "xelatex", "lualatex"]).default("pdflatex"),
    })
    .strict(),
  get_compile_errors: z.object({ ...project, runId: id }).strict(),
  share_project: z
    .object({
      ...project,
      email: z.string().trim().toLowerCase().email().max(320),
      role: z.enum(["EDITOR", "VIEWER"]),
    })
    .strict(),
};
export type McpToolName = keyof typeof schemas;
const scopes: Record<McpToolName, TokenScope> = {
  list_projects: "projects:read",
  list_files: "files:read",
  read_file: "files:read",
  create_file: "files:write",
  edit_file: "files:write",
  write_file: "files:write",
  delete_file: "files:write",
  compile: "compile",
  get_compile_errors: "compile",
  share_project: "projects:share",
};
class ToolAccessError extends Error {}
/** Request-local server; principal is never stored in shared mutable SDK state. */
export function createMcpServer(options: {
  tokens: TokenStore;
  domain: McpDomain;
  principal: AccessTokenRecord;
}) {
  const { domain, tokens, principal } = options;
  const server = new McpServer({ name: "latex-free", version: "1.0.0" });
  for (const name of Object.keys(schemas) as McpToolName[]) {
    server.registerTool(
      name,
      {
        description:
          name === "edit_file"
            ? "Replace exact literal matches atomically; requires current file version and exact expected match count."
            : name === "compile"
              ? "Compile a coherent server-side project snapshot. Returns diagnostics and versions, never a PDF."
              : name === "share_project"
                ? "Grant an existing account editor or viewer membership. Requires owner role. Sends no messages."
                : name.replaceAll("_", " "),
        inputSchema: schemas[name],
        annotations: {
          readOnlyHint: [
            "list_projects",
            "list_files",
            "read_file",
            "get_compile_errors",
          ].includes(name),
          destructiveHint: name === "delete_file",
          openWorldHint: false,
        },
      },
      async (raw: unknown) => {
        try {
          const current = await tokens.findByHash(principal.tokenHash);
          if (
            !current ||
            current.id !== principal.id ||
            current.userId !== principal.userId ||
            current.revokedAt ||
            current.expiresAt <= new Date()
          )
            throw new ToolAccessError("Token is expired or revoked");
          if (!current.scopes.includes(scopes[name]))
            throw new ToolAccessError("Token scope does not permit this tool");
          const input = schemas[name].parse(raw);
          if ("projectId" in input) {
            if (!current.projectIds.includes(input.projectId))
              throw new ToolAccessError("Project not found");
            const role = await domain.role(current.userId, input.projectId);
            if (
              !role ||
              (scopes[name] === "files:write" && role === "VIEWER") ||
              (name === "share_project" && role !== "OWNER")
            )
              throw new ToolAccessError(
                "Project not found or role does not permit this tool",
              );
          }
          const actor = current.userId;
          let result: unknown;
          // Each domain operation repeats authorization inside its transaction/lock.
          switch (name) {
            case "list_projects":
              result = await domain.listProjects(actor, current.projectIds);
              break;
            case "list_files": {
              const a = schemas.list_files.parse(raw);
              result = await domain.listFiles(actor, a.projectId);
              break;
            }
            case "read_file": {
              const a = schemas.read_file.parse(raw);
              result = await domain.readFile(actor, a.projectId, a.fileId);
              break;
            }
            case "create_file": {
              const a = schemas.create_file.parse(raw);
              result = await domain.createFile(actor, a.projectId, a);
              break;
            }
            case "edit_file": {
              const a = schemas.edit_file.parse(raw);
              result = await domain.editFile(actor, a.projectId, a.fileId, a);
              break;
            }
            case "write_file": {
              const a = schemas.write_file.parse(raw);
              result = await domain.writeFile(
                actor,
                a.projectId,
                a.fileId,
                a.expectedVersion,
                a.content,
              );
              break;
            }
            case "delete_file": {
              const a = schemas.delete_file.parse(raw);
              result = await domain.deleteFile(
                actor,
                a.projectId,
                a.fileId,
                a.expectedVersion,
              );
              break;
            }
            case "compile": {
              const a = schemas.compile.parse(raw);
              result = await domain.compile(actor, a.projectId, a);
              break;
            }
            case "get_compile_errors": {
              const a = schemas.get_compile_errors.parse(raw);
              result = await domain.getCompileErrors(
                actor,
                a.projectId,
                a.runId,
              );
              break;
            }
            case "share_project": {
              const a = schemas.share_project.parse(raw);
              result = await domain.shareProject(actor, a.projectId, a);
              break;
            }
          }
          const output = JSON.stringify(result ?? { ok: true });
          if (Buffer.byteLength(output) > 1_000_000)
            throw new ToolAccessError(
              "Result too large; request a smaller file",
            );
          return { content: [{ type: "text" as const, text: output }] };
        } catch (error) {
          const status =
            typeof error === "object" && error !== null && "status" in error
              ? error.status
              : undefined;
          const message =
            error instanceof ToolAccessError
              ? error.message
              : status === 409
                ? "Conflict: file version or exact match count changed; read the file before retrying"
                : status === 404
                  ? "Project or file not found"
                  : status === 413
                    ? "Project or file size limit exceeded"
                    : "Tool failed; check access and input before retrying";
          return {
            isError: true,
            content: [{ type: "text" as const, text: message }],
          };
        }
      },
    );
  }
  return server;
}
export function createMcpRouter(options: {
  tokens: TokenStore;
  domain: McpDomain;
  trustedOrigin: string;
}) {
  const router = express.Router();
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (
      req.headers.origin !== undefined &&
      req.headers.origin !== options.trustedOrigin
    ) {
      res.status(403).json({ error: "Untrusted origin" });
      return;
    }
    next();
  });
  router.use(express.json({ limit: "1mb" }));
  router.post("/", async (req, res) => {
    const principal = await authenticateToken(
      options.tokens,
      req.headers.authorization,
    );
    if (!principal) {
      res.setHeader("WWW-Authenticate", "Bearer");
      res.status(401).json({ error: "Valid personal access token required" });
      return;
    }
    // An earlier app-level parser may have consumed the stream; retain our own bound.
    if (Buffer.byteLength(JSON.stringify(req.body ?? null)) > 1_000_000) {
      res.status(413).json({ error: "Request too large" });
      return;
    }
    const server = createMcpServer({ ...options, principal });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    let closed = false;
    const cleanup = async () => {
      if (closed) return;
      closed = true;
      await Promise.allSettled([transport.close(), server.close()]);
    };
    res.on("close", () => {
      void cleanup();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent)
        res
          .status(500)
          .json({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: "MCP request failed" },
          });
      await cleanup();
    }
  });
  router.all("/", (_req, res) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Use POST for stateless MCP requests" });
  });
  return router;
}
