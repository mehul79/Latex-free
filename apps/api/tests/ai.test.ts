import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  AiError,
  AiProposalService,
  MemoryAiProposalStore,
  createAiRouter,
  createClaudeProvider,
  type AiDomain,
  type AiProvider,
} from "../src/ai/index.js";
import { searchCitations } from "../src/research/index.js";
function setup(
  output: unknown = {
    summary: "Shorten wording using existing facts.",
    edits: [
      {
        fileId: "f1",
        content: "\\section{Experience}\n\\item Built software.",
      },
    ],
    citationKeys: [],
  },
) {
  const store = new MemoryAiProposalStore();
  const files = new Map([
    [
      "f1",
      {
        id: "f1",
        path: "main.tex",
        version: 1,
        content: "\\section{Experience}\n\\item I built software.",
        encoding: "utf8",
      },
    ],
    [
      "bib",
      {
        id: "bib",
        path: "references.bib",
        version: 1,
        content: "",
        encoding: "utf8",
      },
    ],
  ]);
  let role: "OWNER" | "EDITOR" | "VIEWER" | null = "OWNER";
  let now = new Date("2026-01-01T00:00:00Z");
  const domain: AiDomain = {
    role: async () => role,
    readFile: async (_a, _p, id) => {
      const file = files.get(id);
      if (!file) throw new AiError(404, "File not found");
      return structuredClone(file);
    },
    applyProposalAtomic: vi.fn(async (actor, project, id) => {
      const proposal = store.records.get(id)!;
      if (role !== "OWNER" && role !== "EDITOR")
        throw new AiError(403, "Forbidden");
      if (proposal.actorId !== actor || proposal.projectId !== project)
        throw new AiError(404, "Not found");
      if (proposal.status === "applied") return;
      if (proposal.status !== "pending")
        throw new AiError(409, "Status changed");
      if (proposal.expiresAt <= now) throw new AiError(410, "Expired");
      if (
        proposal.payload.changes.some(
          (change) => files.get(change.fileId)?.version !== change.baseVersion,
        )
      )
        throw new AiError(409, "Stale file");
      for (const change of proposal.payload.changes) {
        const file = files.get(change.fileId)!;
        file.content = change.after;
        file.version++;
      }
      proposal.status = "applied";
      proposal.appliedAt = now;
    }),
  };
  const provider: AiProvider = {
    generate: vi.fn(async () => structuredClone(output)),
  };
  const service = new AiProposalService({
    domain,
    store,
    provider,
    now: () => now,
  });
  return {
    service,
    store,
    files,
    domain,
    provider,
    setRole(value: typeof role) {
      role = value;
    },
    setNow(value: Date) {
      now = value;
    },
  };
}
const input = {
  domain: "resume",
  instruction: "Shorten my bullet.",
  fileIds: ["f1"],
};
describe("reviewable AI proposals", () => {
  it("generates a versioned draft without writing source, and includes grounded resume review", async () => {
    const ctx = setup();
    const before = ctx.files.get("f1")!.content;
    const proposal = await ctx.service.create("u1", "p1", input);
    expect(proposal).toMatchObject({
      actorId: "u1",
      projectId: "p1",
      status: "pending",
      payload: {
        changes: [{ fileId: "f1", baseVersion: 1, before }],
        resumeReview: { kind: "source-heuristic" },
      },
    });
    expect(ctx.files.get("f1")!.content).toBe(before);
    expect(ctx.domain.applyProposalAtomic).not.toHaveBeenCalled();
  });
  it("accepts atomically and treats repeated acceptance as idempotent", async () => {
    const ctx = setup();
    const proposal = await ctx.service.create("u1", "p1", input);
    expect((await ctx.service.accept("u1", "p1", proposal.id)).status).toBe(
      "applied",
    );
    expect((await ctx.service.accept("u1", "p1", proposal.id)).status).toBe(
      "applied",
    );
    expect(ctx.domain.applyProposalAtomic).toHaveBeenCalledTimes(1);
    expect(ctx.files.get("f1")!.version).toBe(2);
  });
  it("preserves every file and pending status on a stale multi-file accept", async () => {
    const ctx = setup({
      summary: "Edit both",
      edits: [
        { fileId: "f1", content: "new 1" },
        { fileId: "f2", content: "new 2" },
      ],
      citationKeys: [],
    });
    ctx.files.set("f2", {
      id: "f2",
      path: "second.tex",
      version: 1,
      content: "old 2",
      encoding: "utf8",
    });
    const proposal = await ctx.service.create("u1", "p1", {
      ...input,
      fileIds: ["f1", "f2"],
    });
    ctx.files.get("f2")!.version = 2;
    await expect(
      ctx.service.accept("u1", "p1", proposal.id),
    ).rejects.toMatchObject({ status: 409 });
    expect(ctx.files.get("f1")!.version).toBe(1);
    expect(ctx.files.get("f2")!.content).toBe("old 2");
    expect((await ctx.store.get(proposal.id))!.status).toBe("pending");
  });
  it("rejects without file changes, idempotently, and prevents later acceptance", async () => {
    const ctx = setup();
    const proposal = await ctx.service.create("u1", "p1", input);
    await ctx.service.reject("u1", "p1", proposal.id);
    await ctx.service.reject("u1", "p1", proposal.id);
    await expect(
      ctx.service.accept("u1", "p1", proposal.id),
    ).rejects.toMatchObject({ status: 409 });
    expect(ctx.files.get("f1")!.version).toBe(1);
  });
  it("checks current membership, creator ownership, project binding and expiry", async () => {
    const ctx = setup();
    const proposal = await ctx.service.create("u1", "p1", input);
    await expect(
      ctx.service.get("u2", "p1", proposal.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      ctx.service.get("u1", "p2", proposal.id),
    ).rejects.toMatchObject({ status: 404 });
    ctx.setRole("VIEWER");
    await expect(
      ctx.service.accept("u1", "p1", proposal.id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(ctx.service.create("u1", "p1", input)).rejects.toMatchObject({
      status: 403,
    });
    ctx.setRole("OWNER");
    ctx.setNow(new Date("2026-01-01T00:31:00Z"));
    await expect(
      ctx.service.accept("u1", "p1", proposal.id),
    ).rejects.toMatchObject({ status: 410 });
  });
  it("rechecks revoked membership after provider generation", async () => {
    const ctx = setup();
    vi.mocked(ctx.provider.generate).mockImplementation(async () => {
      ctx.setRole(null);
      return {
        summary: "Edit",
        edits: [{ fileId: "f1", content: "changed" }],
        citationKeys: [],
      };
    });
    await expect(ctx.service.create("u1", "p1", input)).rejects.toMatchObject({
      status: 403,
    });
    expect(ctx.store.records.size).toBe(0);
  });
  it("requires server configuration without making a provider call", async () => {
    expect(createClaudeProvider({})).toBeUndefined();
    expect(createClaudeProvider({ apiKey: "not-logged" })).toBeUndefined();
    const ctx = setup();
    const service = new AiProposalService({
      domain: ctx.domain,
      store: ctx.store,
    });
    expect(service.enabled).toBe(false);
    await expect(service.create("u1", "p1", input)).rejects.toMatchObject({
      status: 503,
    });
    expect(ctx.store.records.size).toBe(0);
  });
  it.each([
    {},
    {
      summary: "x",
      edits: [{ fileId: "outside", content: "x" }],
      citationKeys: [],
    },
    {
      summary: "x",
      edits: [
        { fileId: "f1", content: "x" },
        { fileId: "f1", content: "y" },
      ],
      citationKeys: [],
    },
    {
      summary: "x",
      edits: [{ fileId: "f1", content: "\\cite{fake}" }],
      citationKeys: [],
    },
    {
      summary: "x",
      edits: [{ fileId: "f1", content: "\\bibitem{fake} Invented Author." }],
      citationKeys: [],
    },
  ])("rejects malformed or unauthorized provider output", async (output) => {
    const ctx = setup(output);
    await expect(ctx.service.create("u1", "p1", input)).rejects.toMatchObject({
      status: 502,
    });
    expect(ctx.store.records.size).toBe(0);
  });
  it("enforces request/context/output bounds and selected files", async () => {
    const ctx = setup();
    await expect(
      ctx.service.create("u1", "p1", { ...input, fileIds: ["f1", "f1"] }),
    ).rejects.toMatchObject({ status: 400 });
    ctx.files.get("f1")!.content = "x".repeat(128 * 1024);
    await expect(ctx.service.create("u1", "p1", input)).rejects.toMatchObject({
      status: 413,
    });
    expect(ctx.provider.generate).not.toHaveBeenCalled();
    ctx.files.get("f1")!.content = "source";
    vi.mocked(ctx.provider.generate).mockResolvedValue({
      summary: "x".repeat(256 * 1024 + 1),
    });
    await expect(ctx.service.create("u1", "p1", input)).rejects.toMatchObject({
      status: 502,
    });
  });
  it("enforces one concurrent generation per actor, deadline and rate limit", async () => {
    const ctx = setup();
    let resolve!: (value: unknown) => void;
    vi.mocked(ctx.provider.generate).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const service = new AiProposalService({
      domain: ctx.domain,
      store: ctx.store,
      provider: ctx.provider,
      timeoutMs: 15,
    });
    const pending = service.create("u1", "p1", input);
    const timedOut = expect(pending).rejects.toMatchObject({ status: 504 });
    await new Promise((done) => setTimeout(done, 1));
    await expect(service.create("u1", "p1", input)).rejects.toMatchObject({
      status: 429,
    });
    await timedOut;
    resolve({
      summary: "Late",
      edits: [{ fileId: "f1", content: "Late" }],
      citationKeys: [],
    });
    await new Promise((done) => setTimeout(done, 1));
    expect(ctx.store.records.size).toBe(0);
    const normal = setup();
    for (let count = 0; count < 3; count++)
      await normal.service.create("u1", "p1", input);
    await expect(
      normal.service.create("u1", "p1", input),
    ).rejects.toMatchObject({ status: 429 });
  });
  it("inserts only server-retrieved deterministic BibTeX and rejects model bibliography edits", async () => {
    const [citation] = await searchCitations(
      { query: "test", provider: "crossref" },
      {
        fetch: async () =>
          new Response(
            JSON.stringify({
              status: "ok",
              message: {
                items: [
                  {
                    DOI: "10.1234/verified",
                    title: ["Verified title"],
                    author: [{ family: "Verified Author" }],
                  },
                ],
              },
            }),
          ),
      },
    );
    const ctx = setup({
      summary: "Cite verified work",
      edits: [
        { fileId: "f1", content: `Result \\cite{${citation.bibtexKey}}.` },
      ],
      citationKeys: [citation.bibtexKey],
    });
    const citationSearch = vi
      .fn<typeof searchCitations>()
      .mockResolvedValue([citation]);
    const service = new AiProposalService({
      domain: ctx.domain,
      store: ctx.store,
      provider: ctx.provider,
      citationSearch,
    });
    const proposal = await service.create("u1", "p1", {
      domain: "research",
      instruction: "Add citation",
      fileIds: ["f1", "bib"],
      citationQuery: "test",
    });
    expect(proposal.payload.citations).toEqual([citation]);
    expect(
      proposal.payload.changes.find((change) => change.fileId === "bib")!.after,
    ).toBe("\n" + citation.bibtex + "\n");
    vi.mocked(ctx.provider.generate).mockResolvedValue({
      summary: "bad",
      edits: [{ fileId: "bib", content: "@article{fake, title={invented}}" }],
      citationKeys: [],
    });
    await expect(
      service.create("u1", "p1", {
        domain: "research",
        instruction: "Add citation",
        fileIds: ["f1", "bib"],
      }),
    ).rejects.toMatchObject({ status: 502 });
  });
  it("routes require sessions, trusted mutation origin, and creator visibility", async () => {
    const ctx = setup();
    const app = express();
    app.use(express.json());
    app.use(
      "/api/projects/:projectId/ai/proposals",
      createAiRouter(ctx.service, {
        trustedOrigin: "https://app.example",
        authenticate: async (req) =>
          typeof req.headers["x-test-user"] === "string"
            ? req.headers["x-test-user"]
            : null,
      }),
    );
    await request(app)
      .post("/api/projects/p1/ai/proposals")
      .set("Origin", "https://app.example")
      .send(input)
      .expect(401);
    await request(app)
      .post("/api/projects/p1/ai/proposals")
      .set("x-test-user", "u1")
      .set("Origin", "https://evil.example")
      .send(input)
      .expect(403);
    const created = await request(app)
      .post("/api/projects/p1/ai/proposals")
      .set("x-test-user", "u1")
      .set("Origin", "https://app.example")
      .send(input)
      .expect(200);
    await request(app)
      .get(`/api/projects/p1/ai/proposals/${created.body.id}`)
      .set("x-test-user", "u2")
      .expect(404);
    await request(app)
      .post(`/api/projects/p1/ai/proposals/${created.body.id}/reject`)
      .set("x-test-user", "u1")
      .set("Origin", "https://app.example")
      .expect(200);
  });
});
