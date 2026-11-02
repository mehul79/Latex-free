import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { makeSignature } from "better-auth/crypto";
import request from "supertest";
import WebSocket from "ws";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import * as Y from "yjs";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { readConfig } from "../src/config.js";
import { CollaborationService } from "../src/collaboration.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Use a dedicated migrated _test database");
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
});
const config = readConfig({
  NODE_ENV: "test",
  DATABASE_URL: url,
  BETTER_AUTH_SECRET: "integration-test-secret-at-least-32-characters",
  WEB_ORIGIN: "http://localhost:3000",
});
const auth = createAuth(db, config),
  collaboration = new CollaborationService(db, auth, config),
  app = createApp(db, auth, config, collaboration);
const users: { id: string; cookie: string }[] = [],
  projects: string[] = [],
  clients: {
    provider: HocuspocusProvider;
    socket: HocuspocusProviderWebsocket;
    doc: Y.Doc;
    messages: Record<string, unknown>[];
  }[] = [];
let server: Server, endpoint: string;
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, message = "Timed out") {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await pause();
  }
}
const call = (
  method: "post" | "get" | "put" | "patch" | "delete",
  path: string,
  who = 0,
) =>
  request(app)
    [method](path)
    .set("Cookie", users[who].cookie)
    .set("Origin", config.WEB_ORIGIN);
async function project() {
  const response = await call("post", "/api/projects/import").send({
    name: "Collab",
    files: [{ path: "main.tex", content: "Start" }],
  });
  expect(response.status).toBe(201);
  const project = response.body.project;
  projects.push(project.id);
  await db.membership.createMany({
    data: [
      { projectId: project.id, userId: users[1].id, role: "EDITOR" },
      { projectId: project.id, userId: users[2].id, role: "VIEWER" },
    ],
  });
  return {
    projectId: project.id,
    fileId: project.files[0].id,
    route: `/api/projects/${project.id}/files/${project.files[0].id}`,
    key: `${project.id}:${project.files[0].id}`,
  };
}
async function connect(key: string, who = 0, existing?: Y.Doc) {
  class CookieSocket extends WebSocket {
    constructor(address: string, protocols?: string | string[]) {
      super(address, protocols, {
        headers: { Cookie: users[who].cookie, Origin: config.WEB_ORIGIN },
      });
    }
  }
  const socket = new HocuspocusProviderWebsocket({
    url: endpoint,
    WebSocketPolyfill: CookieSocket,
  });
  const doc = existing ?? new Y.Doc();
  doc.getText("source");
  const messages: Record<string, unknown>[] = [];
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: key,
    document: doc,
    onStateless: ({ payload }) => {
      messages.push(JSON.parse(payload));
    },
  });
  provider.attach();
  const client = { provider, socket, doc, messages };
  clients.push(client);
  await until(() => provider.synced, "Collaboration client failed to sync");
  return client;
}
async function barrier(
  client: Awaited<ReturnType<typeof connect>>,
  sequence: number,
) {
  client.provider.sendStateless(
    JSON.stringify({ type: "persistence-barrier", sequence }),
  );
  await until(
    () =>
      client.messages.some(
        (m) => m.type === "persisted" && m.sequence === sequence,
      ),
    "Persistence barrier not acknowledged",
  );
  return client.messages.find(
    (m) => m.type === "persisted" && m.sequence === sequence,
  )!;
}
async function close(client: Awaited<ReturnType<typeof connect>>) {
  client.provider.destroy();
  client.socket.destroy();
  await pause();
}
describe("real WebSocket collaborative authority with Postgres", () => {
  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      const id = randomUUID(),
        token = randomUUID();
      await db.user.create({
        data: {
          id,
          name: `Collaborator ${i}`,
          email: `${id}@example.test`,
          accounts: {
            create: { id: randomUUID(), accountId: id, providerId: "google" },
          },
        },
      });
      await db.session.create({
        data: {
          id: randomUUID(),
          userId: id,
          token,
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      users.push({
        id,
        cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, config.BETTER_AUTH_SECRET)}`)}`,
      });
    }
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    collaboration.attach(server);
    endpoint = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/collaboration`;
  });
  afterAll(async () => {
    for (const client of clients) await close(client);
    await collaboration.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
    await db.$disconnect();
  });
  it("merges simultaneous edits, persists before barrier ack, and reconnects without duplicate text", async () => {
    const p = await project(),
      a = await connect(p.key),
      b = await connect(p.key, 1);
    expect(a.doc.getText("source").toString()).toBe("Start");
    expect(b.doc.getText("source").toString()).toBe("Start");
    a.doc.getText("source").insert(0, "Alice ");
    b.doc.getText("source").insert(0, "Bob ");
    await barrier(a, 1);
    await barrier(b, 1);
    await until(
      () =>
        a.doc.getText("source").toString() ===
        b.doc.getText("source").toString(),
    );
    const saved = await db.file.findUniqueOrThrow({ where: { id: p.fileId } });
    expect(saved.content).toContain("Alice ");
    expect(saved.content).toContain("Bob ");
    expect(saved.version).toBe(2);
    expect(saved.yState).not.toBeNull();
    expect(a.doc.getText("source").toString()).toBe(saved.content);
    const revisions = await db.fileRevision.findMany({
      where: { fileId: p.fileId, reason: "collaboration" },
    });
    expect(new Set(revisions.map((r) => r.authorId))).toEqual(
      new Set([users[0].id, users[1].id]),
    );
    await close(a);
    const reconnected = await connect(p.key, 0, a.doc);
    await barrier(reconnected, 2);
    expect(reconnected.doc.getText("source").toString()).toBe(saved.content);
    expect(
      (await db.file.findUniqueOrThrow({ where: { id: p.fileId } })).version,
    ).toBe(2);
  });
  it("restores with compare-and-swap through the same live document and preserves its path", async () => {
    const p = await project(),
      a = await connect(p.key),
      b = await connect(p.key, 1);
    a.doc.getText("source").insert(0, "Changed ");
    await barrier(a, 1);
    const initial = await db.fileRevision.findFirstOrThrow({
      where: { fileId: p.fileId, version: 0 },
    });
    const stale = await call(
      "post",
      `${p.route}/revisions/${initial.id}/restore`,
    ).send({ expectedVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.file.version).toBe(1);
    const restored = await call(
      "post",
      `${p.route}/revisions/${initial.id}/restore`,
    ).send({ expectedVersion: 1 });
    expect(restored.status).toBe(200);
    expect(restored.body.file.version).toBe(2);
    expect(restored.body.file.yState).toBeUndefined();
    await until(
      () =>
        a.doc.getText("source").toString() === "Start" &&
        b.doc.getText("source").toString() === "Start",
    );
    await barrier(a, 2);
    expect(
      (await db.file.findUniqueOrThrow({ where: { id: p.fileId } })).content,
    ).toBe("Start");
  });
  it("rejects viewer and oversized edits before they can change a peer document", async () => {
    const p = await project(),
      a = await connect(p.key),
      viewer = await connect(p.key, 2);
    viewer.doc.getText("source").insert(0, "Forbidden ");
    await until(() =>
      viewer.messages.some((m) => m.type === "persistence-error"),
    );
    await pause(60);
    expect(a.doc.getText("source").toString()).toBe("Start");
    expect(
      (await db.file.findUniqueOrThrow({ where: { id: p.fileId } })).version,
    ).toBe(0);
    const editor = await connect(p.key, 1);
    editor.doc.getText("source").insert(0, "x".repeat(1_000_001));
    await until(() =>
      editor.messages.some((m) => m.type === "persistence-error"),
    );
    await pause(60);
    expect(a.doc.getText("source").toString()).toBe("Start");
    expect(
      (await db.file.findUniqueOrThrow({ where: { id: p.fileId } })).content,
    ).toBe("Start");
  });
  it("closes revoked editor connections immediately and denies their pending edits", async () => {
    const p = await project(),
      a = await connect(p.key),
      b = await connect(p.key, 1);
    expect(
      (
        await call(
          "delete",
          `/api/projects/${p.projectId}/members/${users[1].id}`,
        )
      ).status,
    ).toBe(204);
    await until(() => b.messages.some((m) => m.type === "reload-required"));
    b.doc.getText("source").insert(0, "Revoked ");
    await pause(80);
    expect(a.doc.getText("source").toString()).toBe("Start");
    expect(
      (await db.file.findUniqueOrThrow({ where: { id: p.fileId } })).version,
    ).toBe(0);
  });
  it("does not apply, broadcast, or acknowledge changes when the database commit fails", async () => {
    const p = await project(),
      a = await connect(p.key),
      b = await connect(p.key, 1);
    const originalTransaction = db.$transaction;
    const fail = vi
      .spyOn(db, "$transaction")
      .mockRejectedValueOnce(new Error("Simulated commit failure"));
    b.doc.getText("source").insert(0, "Unsaved ");
    b.provider.sendStateless(
      JSON.stringify({ type: "persistence-barrier", sequence: 99 }),
    );
    await until(() => b.messages.some((m) => m.type === "persistence-error"));
    fail.mockRestore();
    db.$transaction = originalTransaction;
    await pause(80);
    expect(
      b.messages.some((m) => m.type === "persisted" && m.sequence === 99),
    ).toBe(false);
    expect(a.doc.getText("source").toString()).toBe("Start");
    expect(
      (await db.file.findUniqueOrThrow({ where: { id: p.fileId } })).content,
    ).toBe("Start");
  });
  it("persists deletion-only updates and metadata-only CRDT changes without duplicate versions", async () => {
    const p = await project(),
      a = await connect(p.key);
    a.doc.getText("source").delete(0, 1);
    expect((await barrier(a, 1)).version).toBe(1);
    const text = a.doc.getText("source");
    a.doc.transact(() => {
      text.insert(0, "z");
      text.delete(0, 1);
    });
    expect((await barrier(a, 2)).version).toBe(2);
    expect(
      (await db.file.findUniqueOrThrow({ where: { id: p.fileId } })).content,
    ).toBe("tart");
    await barrier(a, 3);
    expect(
      (await db.file.findUniqueOrThrow({ where: { id: p.fileId } })).version,
    ).toBe(2);
  });
});
