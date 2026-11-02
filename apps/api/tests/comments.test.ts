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
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Use a dedicated migrated _test database");
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
});
const config = readConfig({
  NODE_ENV: "test",
  DATABASE_URL: url,
  BETTER_AUTH_SECRET: "comments-integration-secret-at-least-32-characters",
  WEB_ORIGIN: "http://localhost:3000",
});
const app = createApp(db, createAuth(db, config), config);
const users: { id: string; cookie: string }[] = [];
let projectId: string, fileId: string, otherFileId: string;
const doc = new Y.Doc();
const source = doc.getText("source");
const route = () => `/api/projects/${projectId}/files/${fileId}/discussions`;
const call = (
  method: "get" | "post" | "patch" | "delete",
  path: string,
  actor = 0,
) =>
  request(app)
    [method](path)
    .set("Cookie", users[actor].cookie)
    .set("Origin", config.WEB_ORIGIN);
beforeAll(async () => {
  for (let i = 0; i < 4; i++) {
    const id = randomUUID(),
      token = randomUUID();
    await db.user.create({
      data: { id, name: `Discussion member ${i}`, email: `${id}@example.test` },
    });
    users.push({
      id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, config.BETTER_AUTH_SECRET)}`)}`,
    });
    await db.session.create({
      data: {
        id: randomUUID(),
        token,
        userId: id,
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
  }
  source.insert(0, "Selected manuscript text");
  const project = await db.project.create({
    data: {
      name: "Discussion security fixture",
      members: {
        create: users
          .slice(0, 3)
          .map((user, i) => ({
            userId: user.id,
            role: (["OWNER", "EDITOR", "VIEWER"] as const)[i],
          })),
      },
      files: {
        create: [
          {
            path: "main.tex",
            content: source.toString(),
            yState: Buffer.from(Y.encodeStateAsUpdate(doc)),
          },
          { path: "other.tex", content: "Other file" },
        ],
      },
    },
    include: { files: true },
  });
  projectId = project.id;
  fileId = project.files.find((file) => file.path === "main.tex")!.id;
  otherFileId = project.files.find((file) => file.path === "other.tex")!.id;
});
afterAll(async () => {
  if (projectId) await db.project.deleteMany({ where: { id: projectId } });
  await db.user.deleteMany({
    where: { id: { in: users.map((user) => user.id) } },
  });
  doc.destroy();
  await db.$disconnect();
});
it("bounds discussions and enforces session, origin, membership, author and anchor authority", async () => {
  const threads = `${route()}/threads`;
  expect((await request(app).get(threads)).status).toBe(401);
  expect(
    (
      await call("post", threads)
        .set("Origin", "https://elsewhere.example")
        .send({ body: "Rejected" })
    ).status,
  ).toBe(403);
  expect(
    (await call("post", threads, 2).send({ body: "Viewer cannot write" }))
      .status,
  ).toBe(404);
  expect((await call("get", threads, 3)).status).toBe(404);
  expect(
    (await call("post", threads).send({ body: "x".repeat(5001) })).status,
  ).toBe(400);
  expect((await call("get", `${threads}?limit=51`)).status).toBe(400);
  expect(
    (
      await call("post", threads).send({
        body: "Bad anchor",
        anchor: { start: "AAAA", end: "AAAA" },
      })
    ).status,
  ).toBe(400);
  const anchor = {
    start: Buffer.from(
      Y.encodeRelativePosition(
        Y.createRelativePositionFromTypeIndex(source, 0),
      ),
    ).toString("base64"),
    end: Buffer.from(
      Y.encodeRelativePosition(
        Y.createRelativePositionFromTypeIndex(source, 8),
      ),
    ).toString("base64"),
  };
  const created = await call("post", threads, 1).send({
    body: "<script>alert('escaped')</script>",
    anchor,
  });
  expect(created.status).toBe(201);
  expect(created.body.thread.anchorStatus).toBe("anchored");
  const threadId = created.body.thread.id,
    commentId = created.body.thread.comments[0].id;
  expect(created.body.thread.comments[0].author).toEqual({
    id: users[1].id,
    name: "Discussion member 1",
    image: null,
  });
  expect(JSON.stringify(created.body)).not.toContain("@example.test");
  const wrongFile = threads.replace(fileId, otherFileId);
  expect(
    (
      await call("post", `${wrongFile}/${threadId}/replies`, 1).send({
        body: "Wrong file",
      })
    ).status,
  ).toBe(404);
  expect((await call("get", `${wrongFile}?cursor=${threadId}`)).status).toBe(
    400,
  );
  const reply = await call("post", `${threads}/${threadId}/replies`).send({
    body: "Owner reply",
  });
  expect(reply.status).toBe(201);
  expect(
    (
      await call(
        "patch",
        `${route()}/comments/${reply.body.comment.id}`,
        1,
      ).send({ body: "Not my comment" })
    ).status,
  ).toBe(404);
  expect(
    (
      await call("patch", `${route()}/comments/${commentId}`, 1).send({
        body: "Author edit",
      })
    ).status,
  ).toBe(200);
  expect(
    (await call("patch", `${threads}/${threadId}`, 1).send({ resolved: true }))
      .body.thread.resolvedAt,
  ).toBeTruthy();
  expect(
    (await call("patch", `${threads}/${threadId}`).send({ resolved: false }))
      .body.thread.resolvedAt,
  ).toBeNull();
  expect(
    (await call("post", threads).send({ body: "Second discussion" })).status,
  ).toBe(201);
  const first = await call("get", `${threads}?limit=1`, 2);
  expect(first.body.threads).toHaveLength(1);
  expect(first.body.nextCursor).toBeTruthy();
  const next = await call(
    "get",
    `${threads}?limit=1&cursor=${first.body.nextCursor}`,
    2,
  );
  expect(next.body.threads[0].id).toBe(threadId);
  source.delete(0, 8);
  await db.file.update({
    where: { id: fileId },
    data: {
      content: source.toString(),
      yState: Buffer.from(Y.encodeStateAsUpdate(doc)),
    },
  });
  const listed = await call("get", threads, 2);
  expect(
    listed.body.threads.find((thread: { id: string }) => thread.id === threadId)
      .anchorStatus,
  ).toBe("detached");
  expect(
    (await call("delete", `${route()}/comments/${commentId}`)).status,
  ).toBe(204);
  await db.membership.delete({
    where: { userId_projectId: { userId: users[1].id, projectId } },
  });
  expect(
    (
      await call("post", `${threads}/${threadId}/replies`, 1).send({
        body: "Revoked member",
      })
    ).status,
  ).toBe(404);
  expect((await call("get", threads, 1)).status).toBe(404);
});
