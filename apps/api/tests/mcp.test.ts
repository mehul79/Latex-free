import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { DocumentService, ApiError } from "../src/document-service.js";
import { ProjectService } from "../src/project-service.js";
import { createMcpRouter } from "../src/mcp/server.js";
import {
  createTokenRouter,
  hashToken,
  authenticateToken,
} from "../src/mcp/tokens.js";
import { McpCompileService } from "../src/mcp/compile-service.js";
import {
  TOKEN_SCOPES,
  type AccessTokenRecord,
  type McpDomain,
  type TokenStore,
} from "../src/mcp/contracts.js";
const origin = "http://localhost:3000";
const raw = `lf_pat_${"a".repeat(43)}`;
function fixture() {
  const token: AccessTokenRecord = {
    id: "token",
    userId: "alice",
    label: "test",
    tokenHash: hashToken(raw),
    scopes: [...TOKEN_SCOPES],
    projectIds: ["p"],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 100_000),
    revokedAt: null,
  };
  const store: TokenStore = {
    findByHash: vi.fn(async (hash) =>
      hash === token.tokenHash ? { ...token } : null,
    ),
    list: vi.fn(async () => [token]),
    create: vi.fn(async (record) => ({
      ...record,
      id: "created",
      createdAt: new Date(),
    })),
    revoke: vi.fn(
      async (userId, id) => userId === token.userId && id === token.id,
    ),
  };
  const domain: McpDomain = {
    role: vi.fn(async () => "OWNER"),
    listProjects: vi.fn(async (actor, ids) => [{ actor, ids }]),
    listFiles: vi.fn(async () => []),
    readFile: vi.fn(async () => ({
      id: "f",
      path: "main.tex",
      content: "source",
      version: 0,
    })),
    createFile: vi.fn(async () => ({})),
    writeFile: vi.fn(async () => ({})),
    editFile: vi.fn(async () => ({})),
    deleteFile: vi.fn(async () => ({})),
    compile: vi.fn(async () => ({
      runId: "run",
      success: true,
      errors: [],
      versions: {},
    })),
    getCompileErrors: vi.fn(async () => ({
      runId: "run",
      success: true,
      errors: [],
      versions: {},
    })),
    shareProject: vi.fn(async () => ({})),
  };
  const app = express();
  app.use(
    "/mcp",
    createMcpRouter({ tokens: store, domain, trustedOrigin: origin }),
  );
  app.use(
    "/api/tokens",
    createTokenRouter({
      tokens: store,
      trustedOrigin: origin,
      getSessionUserId: async (req) =>
        req.headers.cookie === "session=yes" ? "alice" : null,
      canAccessProject: async (_u, p) => p === "p",
    }),
  );
  const rpc = (method: string, params?: unknown, credential = raw) =>
    request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${credential}`)
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });
  return { token, store, domain, app, rpc };
}
describe("stateless MCP transport", () => {
  it("initializes and lists exactly the ten AGENTS tools over HTTP", async () => {
    const { rpc } = fixture();
    const init = await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("latex-free");
    const response = await rpc("tools/list");
    expect(response.status).toBe(200);
    expect(
      response.body.result.tools.map((t: { name: string }) => t.name).sort(),
    ).toEqual(
      [
        "list_projects",
        "list_files",
        "read_file",
        "create_file",
        "edit_file",
        "write_file",
        "delete_file",
        "compile",
        "get_compile_errors",
        "share_project",
      ].sort(),
    );
    expect(response.headers["mcp-session-id"]).toBeUndefined();
  });
  it("requires bearer auth and rejects explicit untrusted origins", async () => {
    const { app, rpc } = fixture();
    expect(
      (await request(app).post("/mcp").set("Cookie", "session=yes").send({}))
        .status,
    ).toBe(401);
    expect(
      (await rpc("tools/list").set("Origin", "https://evil.example")).status,
    ).toBe(403);
    expect((await rpc("tools/list")).status).toBe(200);
    expect((await request(app).get("/mcp")).status).toBe(405);
  });
  it("rejects expired and revoked tokens even on a fresh subsequent request", async () => {
    const { rpc, token } = fixture();
    expect((await rpc("tools/list")).status).toBe(200);
    token.revokedAt = new Date();
    expect((await rpc("tools/list")).status).toBe(401);
    token.revokedAt = null;
    token.expiresAt = new Date(0);
    expect((await rpc("tools/list")).status).toBe(401);
  });
  it("rechecks revocation when a tool begins after request authentication", async () => {
    const { rpc, token, store, domain } = fixture();
    vi.mocked(store.findByHash)
      .mockResolvedValueOnce({ ...token })
      .mockResolvedValueOnce({ ...token, revokedAt: new Date() });
    const response = await rpc("tools/call", {
      name: "list_projects",
      arguments: {},
    });
    expect(response.body.result.isError).toBe(true);
    expect(domain.listProjects).not.toHaveBeenCalled();
  });
  it("intersects scopes, explicit project allowlist and current role before domain access", async () => {
    const { rpc, token, domain } = fixture();
    const call = (projectId = "p") =>
      rpc("tools/call", {
        name: "write_file",
        arguments: { projectId, fileId: "f", expectedVersion: 0, content: "x" },
      });
    expect((await call("other")).body.result.isError).toBe(true);
    expect(domain.writeFile).not.toHaveBeenCalled();
    token.scopes = ["files:read"];
    expect((await call()).body.result.isError).toBe(true);
    token.scopes = ["files:write"];
    vi.mocked(domain.role).mockResolvedValue("VIEWER");
    expect((await call()).body.result.isError).toBe(true);
    vi.mocked(domain.role).mockResolvedValue(null);
    expect((await call()).body.result.isError).toBe(true);
    expect(domain.writeFile).not.toHaveBeenCalled();
  });
  it("keeps simultaneous principal contexts separate", async () => {
    const { app, token, store, domain } = fixture();
    const second = `lf_pat_${"b".repeat(43)}`;
    vi.mocked(store.findByHash).mockImplementation(async (hash) =>
      hash === hashToken(raw)
        ? { ...token }
        : hash === hashToken(second)
          ? {
              ...token,
              id: "other-token",
              userId: "bob",
              tokenHash: hashToken(second),
              projectIds: ["q"],
            }
          : null,
    );
    vi.mocked(domain.listProjects).mockImplementation(async (actor, ids) => {
      await new Promise((resolve) =>
        setTimeout(resolve, actor === "alice" ? 10 : 1),
      );
      return { actor, ids };
    });
    const responses = await Promise.all(
      [raw, second].map((credential) =>
        request(app)
          .post("/mcp")
          .set("Authorization", `Bearer ${credential}`)
          .set("Accept", "application/json, text/event-stream")
          .send({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "list_projects", arguments: {} },
          }),
      ),
    );
    expect(
      responses.map((r) => JSON.parse(r.body.result.content[0].text)),
    ).toEqual([
      { actor: "alice", ids: ["p"] },
      { actor: "bob", ids: ["q"] },
    ]);
  });
  it("returns a stable conflict without exposing file contents", async () => {
    const { rpc, domain } = fixture();
    vi.mocked(domain.editFile).mockRejectedValue(
      new ApiError(409, "secret current content"),
    );
    const response = await rpc("tools/call", {
      name: "edit_file",
      arguments: {
        projectId: "p",
        fileId: "f",
        expectedVersion: 0,
        find: "a",
        replace: "b",
        expectedMatches: 1,
      },
    });
    expect(response.body.result.isError).toBe(true);
    expect(response.body.result.content[0].text).toContain("Conflict");
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });
});
describe("personal access token lifecycle", () => {
  it("reveals plaintext only once and persists only SHA-256", async () => {
    const { app, store } = fixture();
    const response = await request(app)
      .post("/api/tokens")
      .set("Cookie", "session=yes")
      .set("Origin", origin)
      .send({ label: "agent", scopes: ["files:read"], projectIds: ["p"] });
    expect(response.status).toBe(201);
    expect(response.body.token).toMatch(/^lf_pat_[A-Za-z0-9_-]{43}$/);
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenHash: hashToken(response.body.token),
        userId: "alice",
      }),
      20,
    );
    expect(JSON.stringify(response.body.metadata)).not.toContain("tokenHash");
    const list = await request(app)
      .get("/api/tokens")
      .set("Cookie", "session=yes");
    expect(list.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(list.body)).not.toContain("tokenHash");
    expect(JSON.stringify(list.body)).not.toContain(raw);
    expect(
      (
        await request(app)
          .delete("/api/tokens/token")
          .set("Cookie", "session=yes")
          .set("Origin", origin)
      ).status,
    ).toBe(204);
  });
  it("enforces cookie auth, origin, bounded expiry, scopes and allowlist", async () => {
    const { app, store } = fixture();
    expect(
      (
        await request(app)
          .get("/api/tokens")
          .set("Authorization", `Bearer ${raw}`)
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post("/api/tokens")
          .set("Cookie", "session=yes")
          .send({})
      ).status,
    ).toBe(403);
    for (const change of [
      { expiresInDays: 91 },
      { projectIds: [] },
      { scopes: ["admin"] },
      { label: "" },
    ]) {
      expect(
        (
          await request(app)
            .post("/api/tokens")
            .set("Cookie", "session=yes")
            .set("Origin", origin)
            .send({
              label: "agent",
              scopes: ["files:read"],
              projectIds: ["p"],
              ...change,
            })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await request(app)
          .post("/api/tokens")
          .set("Cookie", "session=yes")
          .set("Origin", origin)
          .send({ label: "agent", scopes: ["files:read"], projectIds: ["q"] })
      ).status,
    ).toBe(404);
    expect(store.create).not.toHaveBeenCalled();
  });
  it("never accepts malformed or arbitrary cookie token strings", async () => {
    const { store } = fixture();
    expect(await authenticateToken(store, "Bearer short")).toBeNull();
    expect(store.findByHash).not.toHaveBeenCalled();
  });
});
describe("exact replacement and compile domain", () => {
  it("checks exact literal match count and compare-and-swaps through the document authority", async () => {
    const writeText = vi.fn(async () => ({ version: 3 }));
    const projects = new ProjectService(
      {} as PrismaClient,
      { writeText } as unknown as DocumentService,
    );
    vi.spyOn(projects, "readFile").mockResolvedValue({
      id: "f",
      projectId: "p",
      path: "main.tex",
      content: "a a",
      version: 2,
      encoding: "utf8",
      mimeType: null,
      yState: null,
    });
    await expect(
      projects.editFile("alice", "p", "f", {
        expectedVersion: 2,
        find: "a",
        replace: "b",
        expectedMatches: 1,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(writeText).not.toHaveBeenCalled();
    writeText.mockRejectedValueOnce(new ApiError(409, "concurrent update"));
    await expect(
      projects.editFile("alice", "p", "f", {
        expectedVersion: 2,
        find: "a",
        replace: "b",
        expectedMatches: 2,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(writeText).toHaveBeenCalledWith("p", "f", "alice", 2, "b b", "edit");
  });
  it("compiles only a server snapshot, caches bounded diagnostics and rechecks role", async () => {
    const projects = {
      compileSnapshot: vi.fn(async () => ({
        files: [{ path: "main.tex", content: "server text" }],
        versions: { f: 2 },
      })),
      role: vi.fn(async () => "OWNER"),
    };
    const worker = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "failed",
            log: "private log",
            pdfBase64: "secretpdf",
            diagnostics: [{ severity: "error", message: "TeX error" }],
            durationMs: 1,
          }),
          { status: 200 },
        ),
    );
    const compiler = new McpCompileService(
      projects as unknown as ProjectService,
      { COMPILER_URL: "http://worker", COMPILER_TOKEN: "worker-secret" },
      worker as typeof fetch,
    );
    const result = await compiler.compile("alice", "p", {
      mainFile: "main.tex",
      engine: "pdflatex",
    });
    expect(result.versions).toEqual({ f: 2 });
    expect(JSON.stringify(result)).not.toMatch(/private log|secretpdf/);
    expect(projects.compileSnapshot).toHaveBeenCalledWith("alice", "p");
    expect(await compiler.getCompileErrors("alice", "p", result.runId)).toEqual(
      { ...result, stale: false, currentVersions: { f: 2 } },
    );
    projects.compileSnapshot.mockResolvedValueOnce({
      files: [{ path: "main.tex", content: "changed" }],
      versions: { f: 3 },
    });
    expect(
      (await compiler.getCompileErrors("alice", "p", result.runId)).stale,
    ).toBe(true);
    await expect(
      compiler.getCompileErrors("bob", "p", result.runId),
    ).rejects.toMatchObject({ status: 404 });
    projects.role.mockResolvedValueOnce(null as unknown as string);
    await expect(
      compiler.getCompileErrors("alice", "p", result.runId),
    ).rejects.toMatchObject({ status: 404 });
  });
});
