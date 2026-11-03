import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { makeSignature } from "better-auth/crypto";
import request from "supertest";
import * as Y from "yjs";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { readConfig } from "../src/config.js";
import { DocumentService } from "../src/document-service.js";
import { ProjectService } from "../src/project-service.js";
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
const app = createApp(db, createAuth(db, config), config);
const users: { id: string; cookie: string }[] = [];
let pid: string;
function call(
  method: "get" | "post" | "put" | "patch" | "delete",
  path: string,
  who = 0,
) {
  return request(app)
    [method](path)
    .set("Cookie", users[who].cookie)
    .set("Origin", config.WEB_ORIGIN);
}
beforeAll(async () => {
  for (let i = 0; i < 4; i++) {
    const id = randomUUID(),
      token = randomUUID();
    await db.user.create({
      data: { id, name: `Trash member ${i}`, email: `${id}@example.test` },
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
  const created = await call("post", "/api/projects").send({
    name: "Trash retention",
  });
  expect(created.status).toBe(201);
  pid = created.body.project.id;
  await db.membership.createMany({
    data: [
      { projectId: pid, userId: users[1].id, role: "EDITOR" },
      { projectId: pid, userId: users[2].id, role: "VIEWER" },
    ],
  });
});
afterAll(async () => {
  if (pid) await db.project.deleteMany({ where: { id: pid } });
  await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await db.$disconnect();
});
it("retains files until explicit owner purge, hides deleted documents, and restores identity with CAS and collision protection", async () => {
  const route = `/api/projects/${pid}`;
  const file = await db.file.findFirstOrThrow({ where: { projectId: pid } });
  const fid = file.id,
    fr = `${route}/files/${fid}`,
    tr = `${route}/trash/${fid}`;
  const doc = new Y.Doc();
  doc.getText("source").insert(0, file.content);
  const yState = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  await db.file.update({ where: { id: fid }, data: { yState } });
  const discussion = await call("post", `${fr}/discussions/threads`).send({
    body: "Retained discussion",
  });
  expect(discussion.status).toBe(201);
  for (const who of [2, 3])
    expect((await call("get", `${route}/trash`, who)).status).toBe(404);
  expect((await call("delete", `${fr}?version=1`)).status).toBe(409);
  expect((await call("delete", `${fr}?version=0`, 2)).status).toBe(404);
  expect((await call("delete", `${fr}?version=0`, 1)).status).toBe(204);
  const stored = await db.file.findUniqueOrThrow({ where: { id: fid } });
  expect(stored.deletedAt).not.toBeNull();
  expect(stored.version).toBe(1);
  expect(stored.yState).toEqual(yState);
  const trash = await call("get", `${route}/trash`, 1);
  expect(trash.status).toBe(200);
  expect(trash.body.files[0]).toMatchObject({
    id: fid,
    path: file.path,
    version: 1,
  });
  expect(trash.body.files[0]).not.toHaveProperty("content");
  expect(trash.body.files[0]).not.toHaveProperty("yState");
  const projects = await call("get", "/api/projects");
  expect(
    projects.body.projects.find((p: { id: string }) => p.id === pid).files,
  ).toEqual([]);
  expect(
    (await call("patch", route).send({ name: "Still hidden" })).body.project
      .files,
  ).toEqual([]);
  for (const [method, path, body] of [
    ["put", fr, { version: 1, content: "Cannot undelete" }],
    ["patch", fr, { version: 1, path: "other.tex" }],
    ["get", `${fr}/revisions`, undefined],
    ["get", `${fr}/discussions/threads`, undefined],
  ] as const) {
    const response = body
      ? await call(method, path).send(body)
      : await call(method, path);
    expect(response.status).toBe(404);
  }
  const domain = new ProjectService(db, new DocumentService(db));
  expect(await domain.listFiles(users[0].id, pid)).toEqual([]);
  expect((await domain.compileSnapshot(users[0].id, pid)).files).toEqual([]);
  await expect(domain.readFile(users[0].id, pid, fid)).rejects.toMatchObject({
    status: 404,
  });
  expect(
    (await call("post", `${tr}/restore`, 2).send({ version: 1 })).status,
  ).toBe(404);
  expect(
    (await call("post", `${tr}/restore`).send({ version: 0 })).status,
  ).toBe(409);
  const replacement = await call("post", `${route}/files`).send({
    path: file.path,
    content: "Replacement",
  });
  expect(replacement.status).toBe(201);
  for (const path of [undefined, `${file.path}/child.tex`])
    expect(
      (await call("post", `${tr}/restore`, 1).send({ version: 1, path }))
        .status,
    ).toBe(409);
  expect(
    (await db.file.findUniqueOrThrow({ where: { id: fid } })).deletedAt,
  ).not.toBeNull();
  const restored = await call("post", `${tr}/restore`, 1).send({
    version: 1,
    path: "recovered/original.tex",
  });
  expect(restored.status).toBe(200);
  expect(restored.body.file).toMatchObject({
    id: fid,
    version: 2,
    content: file.content,
    path: "recovered/original.tex",
    deletedAt: null,
  });
  expect(
    (await db.file.findUniqueOrThrow({ where: { id: fid } })).yState,
  ).toEqual(yState);
  expect(
    (await call("get", `${fr}/revisions`)).body.revisions.map(
      (r: { reason: string }) => r.reason,
    ),
  ).toEqual(["trash-restore", "trash", "create"]);
  expect(
    (await call("get", `${fr}/discussions/threads`)).body.threads[0].comments[0]
      .body,
  ).toBe("Retained discussion");
  expect((await call("delete", `${tr}?version=2`)).status).toBe(404);
  expect(
    (await call("post", `${tr}/restore`).send({ version: 1 })).status,
  ).toBe(404);
  expect((await call("delete", `${fr}?version=2`)).status).toBe(204);
  expect((await call("delete", `${tr}?version=3`, 1)).status).toBe(404);
  expect((await call("delete", `${tr}?version=2`)).status).toBe(409);
  expect((await call("delete", `${tr}?version=3`)).status).toBe(204);
  expect(await db.file.findUnique({ where: { id: fid } })).toBeNull();
  expect(await db.fileRevision.count({ where: { fileId: fid } })).toBe(0);
  expect(await db.commentThread.count({ where: { fileId: fid } })).toBe(0);
});
