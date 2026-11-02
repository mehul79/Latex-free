import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { makeSignature } from "better-auth/crypto";
import request from "supertest";
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
  BETTER_AUTH_SECRET: "integration-test-secret-at-least-32-characters",
  WEB_ORIGIN: "http://localhost:3000",
});
const app = createApp(db, createAuth(db, config), config);
const users: { id: string; email: string; cookie: string }[] = [];
const projects: string[] = [];
let pid: string, fid: string;
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
const projectRoute = () => `/api/projects/${pid}`;
const fileRoute = () => `${projectRoute()}/files/${fid}`;
const membersRoute = () => `${projectRoute()}/members`;
describe("sharing and immutable text history against real Postgres", () => {
  beforeAll(async () => {
    for (let i = 0; i < 4; i++) {
      const id = randomUUID(),
        token = randomUUID(),
        email = `${id}@example.test`;
      await db.user.create({
        data: {
          id,
          name: `Member ${i}`,
          email,
          accounts: {
            create: { id: randomUUID(), accountId: id, providerId: "google" },
          },
        },
      });
      await db.session.create({
        data: {
          id: randomUUID(),
          token,
          userId: id,
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      users.push({
        id,
        email,
        cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, config.BETTER_AUTH_SECRET)}`)}`,
      });
    }
    const created = await call("post", "/api/projects").send({
      name: "History test",
    });
    expect(created.status).toBe(201);
    pid = created.body.project.id;
    fid = created.body.project.files[0].id;
    projects.push(pid);
  });
  afterAll(async () => {
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
    await db.$disconnect();
  });
  it("restricts member management and validates existing Google accounts, duplicates, and owners", async () => {
    expect((await call("get", membersRoute(), 1)).status).toBe(404);
    expect(
      (
        await call("post", membersRoute()).send({
          email: "unknown@example.test",
          role: "EDITOR",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("post", membersRoute()).send({
          email: users[1].email,
          role: "OWNER",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("post", membersRoute()).send({
          email: ` ${users[1].email.toUpperCase()} `,
          role: "EDITOR",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call("post", membersRoute()).send({
          email: users[1].email,
          role: "VIEWER",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("post", membersRoute()).send({
          email: users[2].email,
          role: "VIEWER",
        })
      ).status,
    ).toBe(201);
    expect((await call("get", membersRoute())).body.members).toHaveLength(3);
    for (const who of [1, 2, 3]) {
      expect((await call("get", membersRoute(), who)).status).toBe(404);
      expect(
        (
          await call("patch", `${membersRoute()}/${users[2].id}`, who).send({
            role: "EDITOR",
          })
        ).status,
      ).toBe(404);
      expect(
        (await call("delete", `${membersRoute()}/${users[2].id}`, who)).status,
      ).toBe(404);
    }
    for (const method of ["patch", "delete"] as const)
      expect(
        (
          await call(method, `${membersRoute()}/${users[0].id}`).send({
            role: "VIEWER",
          })
        ).status,
      ).toBe(400);
  });
  it("snapshots creation, edits and renames; paginates metadata and restores content at the current path", async () => {
    const initial = (await call("get", `${fileRoute()}/revisions`, 2)).body
      .revisions[0];
    expect(initial).toMatchObject({
      version: 0,
      reason: "create",
      path: "main.tex",
      author: { id: users[0].id },
    });
    expect(initial.content).toBeUndefined();
    const original = (
      await call("get", `${fileRoute()}/revisions/${initial.id}`, 2)
    ).body.revision.content;
    expect(
      (
        await call("put", fileRoute(), 1).send({
          content: "Edited",
          version: 0,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("patch", fileRoute(), 1).send({
          path: "renamed.tex",
          version: 1,
        })
      ).status,
    ).toBe(200);
    const page = await call("get", `${fileRoute()}/revisions?limit=2`, 2);
    expect(
      page.body.revisions.map((r: { reason: string }) => r.reason),
    ).toEqual(["rename", "edit"]);
    expect(
      (
        await call(
          "get",
          `${fileRoute()}/revisions?cursor=${page.body.nextCursor}`,
          2,
        )
      ).body.revisions[0].id,
    ).toBe(initial.id);
    expect(
      (
        await call(
          "post",
          `${fileRoute()}/revisions/${initial.id}/restore`,
          2,
        ).send({ expectedVersion: 2 })
      ).status,
    ).toBe(404);
    const restored = await call(
      "post",
      `${fileRoute()}/revisions/${initial.id}/restore`,
      1,
    ).send({ expectedVersion: 2 });
    expect(restored.status).toBe(200);
    expect(restored.body.file).toMatchObject({
      content: original,
      path: "renamed.tex",
      version: 3,
    });
    const stale = await call(
      "post",
      `${fileRoute()}/revisions/${initial.id}/restore`,
    ).send({ expectedVersion: 2 });
    expect(stale.status).toBe(409);
    expect(stale.body.file.version).toBe(3);
    expect(
      (await call("get", `${fileRoute()}/revisions/${initial.id}`)).body
        .revision.content,
    ).toBe(original);
    const all = (await call("get", `${fileRoute()}/revisions`)).body.revisions;
    expect(all.map((r: { reason: string }) => r.reason)).toEqual([
      "restore",
      "rename",
      "edit",
      "create",
    ]);
    expect(await db.fileRevision.count({ where: { fileId: fid } })).toBe(4);
  });
  it("isolates cross-file, cross-project, nonmember and binary history", async () => {
    const revision = await db.fileRevision.findFirstOrThrow({
      where: { fileId: fid },
    });
    const other = await call("post", `${projectRoute()}/files`).send({
      path: "other.tex",
      content: "other",
    });
    const binary = await call("post", `${projectRoute()}/files`).send({
      path: "asset.png",
      content: "AA==",
      encoding: "base64",
    });
    for (const id of [other.body.file.id, binary.body.file.id]) {
      expect(
        (
          await call(
            "get",
            `${projectRoute()}/files/${id}/revisions/${revision.id}`,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await call(
            "post",
            `${projectRoute()}/files/${id}/revisions/${revision.id}/restore`,
          ).send({ expectedVersion: 0 })
        ).status,
      ).toBe(404);
    }
    expect(
      await db.fileRevision.count({ where: { fileId: binary.body.file.id } }),
    ).toBe(0);
    expect((await call("get", `${fileRoute()}/revisions`, 3)).status).toBe(404);
    const another = await call("post", "/api/projects").send({ name: "Other" });
    projects.push(another.body.project.id);
    expect(
      (
        await call(
          "get",
          `/api/projects/${another.body.project.id}/files/${fid}/revisions`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          "get",
          `${fileRoute()}/revisions?cursor=${other.body.file.id}`,
        )
      ).status,
    ).toBe(400);
  });
  it("creates lazy baselines for legacy text and cascades history on deletion", async () => {
    const legacy = await db.file.create({
      data: {
        projectId: pid,
        path: "legacy.tex",
        content: "Legacy",
        version: 7,
      },
    });
    const route = `${projectRoute()}/files/${legacy.id}`;
    expect(
      (await call("put", route).send({ content: "New", version: 7 })).status,
    ).toBe(200);
    expect(
      (
        await db.fileRevision.findMany({
          where: { fileId: legacy.id },
          orderBy: { version: "asc" },
        })
      ).map((r) => ({
        version: r.version,
        reason: r.reason,
        content: r.content,
        authorId: r.authorId,
      })),
    ).toEqual([
      { version: 7, reason: "baseline", content: "Legacy", authorId: null },
      { version: 8, reason: "edit", content: "New", authorId: users[0].id },
    ]);
    expect((await call("delete", `${route}?version=8`)).status).toBe(204);
    expect(await db.fileRevision.count({ where: { fileId: legacy.id } })).toBe(
      0,
    );
  });
  it("keeps failed quota restores immutable and preserves snapshots after author deletion", async () => {
    const project = await call("post", "/api/projects/import").send({
      name: "Quota history",
      files: [{ path: "main.tex", content: "x".repeat(1_000_000) }],
    });
    expect(project.status).toBe(201);
    const projectId = project.body.project.id,
      fileId = project.body.project.files[0].id;
    projects.push(projectId);
    const route = `/api/projects/${projectId}/files/${fileId}`;
    const original = await db.fileRevision.findFirstOrThrow({
      where: { fileId },
    });
    expect(
      (await call("put", route).send({ content: "", version: 0 })).status,
    ).toBe(200);
    const bytes = Buffer.alloc(5 * 1024 * 1024).toString("base64");
    await db.file.createMany({
      data: Array.from({ length: 4 }, (_, i) => ({
        projectId,
        path: `asset${i}.bin`,
        encoding: "base64",
        content: bytes,
      })),
    });
    const restore = await call(
      "post",
      `${route}/revisions/${original.id}/restore`,
    ).send({ expectedVersion: 1 });
    expect(restore.status).toBe(413);
    expect(await db.fileRevision.count({ where: { fileId } })).toBe(2);
    expect(
      (await db.file.findUniqueOrThrow({ where: { id: fileId } })).version,
    ).toBe(1);
    const author = randomUUID();
    await db.user.create({
      data: {
        id: author,
        name: "Deleted author",
        email: `${author}@example.test`,
      },
    });
    await db.fileRevision.update({
      where: { id: original.id },
      data: { authorId: author },
    });
    await db.user.delete({ where: { id: author } });
    expect(
      (await call("get", `${route}/revisions/${original.id}`)).body.revision,
    ).toMatchObject({ author: null, content: original.content });
  });
  it("revokes editor authority for metadata and every file mutation", async () => {
    expect(
      (
        await call("patch", `${membersRoute()}/${users[1].id}`).send({
          role: "VIEWER",
        })
      ).status,
    ).toBe(200);
    const revision = await db.fileRevision.findFirstOrThrow({
      where: { fileId: fid },
    });
    for (const [method, route, body] of [
      ["patch", projectRoute(), { name: "Denied" }],
      ["post", `${projectRoute()}/files`, { path: "denied.tex" }],
      ["put", fileRoute(), { content: "Denied", version: 3 }],
      ["patch", fileRoute(), { path: "denied.tex", version: 3 }],
      ["delete", `${fileRoute()}?version=3`, {}],
      [
        "post",
        `${fileRoute()}/revisions/${revision.id}/restore`,
        { expectedVersion: 3 },
      ],
    ] as const)
      expect((await call(method, route, 1).send(body)).status).toBe(404);
    expect(
      (await call("delete", `${membersRoute()}/${users[1].id}`)).status,
    ).toBe(204);
    expect((await call("get", `${fileRoute()}/revisions`, 1)).status).toBe(404);
    expect((await call("get", "/api/projects", 1)).body.projects).toEqual([]);
  });
  it("checks authority after acquiring the project lock when revocation wins a race", async () => {
    await call("post", membersRoute()).send({
      email: users[1].email,
      role: "EDITOR",
    });
    let release!: () => void;
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revocation = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${pid} FOR UPDATE`;
      await tx.membership.delete({
        where: { userId_projectId: { userId: users[1].id, projectId: pid } },
      });
      locked();
      await wait;
    });
    await acquired;
    const write = call("put", fileRoute(), 1)
      .send({ content: "Race overwrite", version: 3 })
      .then((r) => r);
    // Let the HTTP handler reach its lock while the revocation remains uncommitted.
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await revocation;
    expect((await write).status).toBe(404);
    expect(
      (await db.file.findUniqueOrThrow({ where: { id: fid } })).version,
    ).toBe(3);
  });
});
