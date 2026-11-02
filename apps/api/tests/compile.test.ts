import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import type { Auth } from "../src/auth.js";

let worker: Server;
let workerUrl: string;
let workerStatus = 200;
let workerBody: unknown;
let forwardedAuthorization: string | undefined;
let forwardedBody = "";
const config = readConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://unused",
  BETTER_AUTH_SECRET: "integration-test-secret-at-least-32-characters",
});
const noSession = { api: { getSession: async () => null } } as unknown as Auth;
const app = (overrides: Partial<typeof config> = {}) =>
  createApp({} as PrismaClient, noSession, {
    ...config,
    COMPILER_URL: workerUrl,
    COMPILER_TOKEN: "test-compiler-token-long",
    ENABLE_LOCAL_COMPILE: true,
    ...overrides,
  });
const input = {
  files: [{ path: "main.tex", content: "hello" }],
  mainFile: "main.tex",
  engine: "pdflatex",
};
const result = {
  status: "succeeded",
  pdfBase64: "JVBERg==",
  log: "compiled",
  diagnostics: [],
  durationMs: 100,
};
describe("compile adapter", () => {
  beforeAll(async () => {
    worker = createServer(async (req, res) => {
      forwardedAuthorization = req.headers.authorization;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      forwardedBody = Buffer.concat(chunks).toString();
      res.writeHead(workerStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify(workerBody ?? result));
    });
    await new Promise<void>((resolve) =>
      worker.listen(0, "127.0.0.1", resolve),
    );
    workerUrl = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      worker.close((error) => (error ? reject(error) : resolve())),
    );
  });
  it("forwards validated snapshots with worker authentication", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const response = await request(app())
      .post("/api/compile")
      .set("Origin", config.WEB_ORIGIN)
      .send(input);
    expect(timeout).toHaveBeenCalledWith(90_000);
    timeout.mockRestore();
    expect(response.status).toBe(200);
    expect(response.body).toEqual(result);
    expect(forwardedAuthorization).toBe("Bearer test-compiler-token-long");
    expect(JSON.parse(forwardedBody).files[0].encoding).toBe("utf8");
  });
  it("blocks untrusted writes, unauthenticated default and production local mode", async () => {
    expect((await request(app()).post("/api/compile").send(input)).status).toBe(
      403,
    );
    for (const overrides of [
      { ENABLE_LOCAL_COMPILE: false },
      { NODE_ENV: "production" as const },
    ])
      expect(
        (
          await request(app(overrides))
            .post("/api/compile")
            .set("Origin", config.WEB_ORIGIN)
            .send(input)
        ).status,
      ).toBe(401);
  });
  it("validates input and reports unavailable and busy workers", async () => {
    expect(
      (
        await request(app())
          .post("/api/compile")
          .set("Origin", config.WEB_ORIGIN)
          .send({ ...input, mainFile: "../bad.tex" })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app({ COMPILER_URL: undefined }))
          .post("/api/compile")
          .set("Origin", config.WEB_ORIGIN)
          .send(input)
      ).status,
    ).toBe(503);
    workerStatus = 429;
    expect(
      (
        await request(app())
          .post("/api/compile")
          .set("Origin", config.WEB_ORIGIN)
          .send(input)
      ).status,
    ).toBe(429);
    workerStatus = 200;
    workerBody = { untrusted: true };
    expect(
      (
        await request(app())
          .post("/api/compile")
          .set("Origin", config.WEB_ORIGIN)
          .send(input)
      ).status,
    ).toBe(503);
    workerBody = {
      ...result,
      status: "failed",
      pdfBase64: undefined,
      diagnostics: [
        { severity: "error", message: "Undefined control sequence" },
      ],
    };
    const failed = await request(app())
      .post("/api/compile")
      .set("Origin", config.WEB_ORIGIN)
      .send(input);
    expect(failed.status).toBe(200);
    expect(failed.body.status).toBe("failed");
  });
});
