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
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, dedicated database whose name ends in _test.",
  );
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
const userIds: string[] = [];
const projectIds: string[] = [];
let ownerCookie: string, otherCookie: string, viewerCookie: string;
async function userCookie() {
  const id = randomUUID(),
    token = randomUUID();
  userIds.push(id);
  await db.user.create({
    data: { id, name: "Integration user", email: `${id}@example.test` },
  });
  await db.session.create({
    data: {
      id: randomUUID(),
      token,
      userId: id,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  return `better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, config.BETTER_AUTH_SECRET)}`)}`;
}
const write = (cookie: string) =>
  request(app)
    .post("/api/projects")
    .set("Cookie", cookie)
    .set("Origin", config.WEB_ORIGIN);
describe("authenticated projects against Postgres and Better Auth", () => {
  beforeAll(async () => {
    await db.$connect();
    ownerCookie = await userCookie();
    otherCookie = await userCookie();
    viewerCookie = await userCookie();
  });
  afterAll(async () => {
    await db.project.deleteMany({ where: { id: { in: projectIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  });
  it("rejects anonymous access and tampered session cookies", async () => {
    expect((await request(app).get("/api/projects")).status).toBe(401);
    expect(
      (
        await request(app)
          .get("/api/projects")
          .set("Cookie", "better-auth.session_token=forged.invalid")
      ).status,
    ).toBe(401);
  });
  it("validates input and rejects cross-origin writes", async () => {
    expect((await write(ownerCookie).send({ name: " " })).status).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/projects")
          .set("Cookie", ownerCookie)
          .set("Origin", "https://other.example")
          .send({ name: "Blocked" })
      ).status,
    ).toBe(403);
  });
  it("creates a project and isolates users’ project lists", async () => {
    const result = await write(ownerCookie).send({
      name: "Research",
      template: "article",
    });
    expect(result.status).toBe(201);
    projectIds.push(result.body.project.id);
    expect(result.body.project.files[0].content).toContain("\\begin{abstract}");
    const owner = await request(app)
      .get("/api/projects")
      .set("Cookie", ownerCookie);
    expect(owner.body.projects.map((p: { id: string }) => p.id)).toContain(
      projectIds[0],
    );
    const other = await request(app)
      .get("/api/projects")
      .set("Cookie", otherCookie);
    expect(other.body.projects).toEqual([]);
  });
  it("blocks nonmembers and viewer writes", async () => {
    const id = projectIds[0];
    await db.membership.create({
      data: { projectId: id, userId: userIds[2], role: "VIEWER" },
    });
    for (const cookie of [otherCookie, viewerCookie]) {
      expect(
        (
          await request(app)
            .patch(`/api/projects/${id}`)
            .set("Cookie", cookie)
            .set("Origin", config.WEB_ORIGIN)
            .send({ name: "Hijacked" })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(app)
            .delete(`/api/projects/${id}`)
            .set("Cookie", cookie)
            .set("Origin", config.WEB_ORIGIN)
        ).status,
      ).toBe(404);
    }
  });
  it("saves a file and rejects a stale write without losing content", async () => {
    const id = projectIds[0],
      file = await db.file.findFirstOrThrow({ where: { projectId: id } });
    const save = (content: string) =>
      request(app)
        .put(`/api/projects/${id}/files/${file.id}`)
        .set("Cookie", ownerCookie)
        .set("Origin", config.WEB_ORIGIN)
        .send({ content, version: 0 });
    const saved = await save("First save");
    expect(saved.status).toBe(200);
    expect(saved.body.file.version).toBe(1);
    const stale = await save("Stale overwrite");
    expect(stale.status).toBe(409);
    expect(stale.body.file).toMatchObject({
      content: "First save",
      version: 1,
    });
    expect(
      (await db.file.findUniqueOrThrow({ where: { id: file.id } })).content,
    ).toBe("First save");
  });
  it("rejects unsafe and duplicate file paths", async () => {
    const endpoint = `/api/projects/${projectIds[0]}/files`;
    const add = (path: string) =>
      request(app)
        .post(endpoint)
        .set("Cookie", ownerCookie)
        .set("Origin", config.WEB_ORIGIN)
        .send({ path });
    expect((await add("../secret.tex")).status).toBe(400);
    expect((await add("notes.tex")).status).toBe(201);
    expect((await add("notes.tex")).status).toBe(409);
  });
  it("imports binary assets atomically and returns viewer roles", async () => {
    const result = await request(app)
      .post("/api/projects/import")
      .set("Cookie", ownerCookie)
      .set("Origin", config.WEB_ORIGIN)
      .send({
        name: "Imported",
        files: [
          { path: "main.tex", content: "hello" },
          {
            path: "images/pixel.png",
            content: "AA==",
            encoding: "base64",
            mimeType: "image/png",
          },
        ],
      });
    expect(result.status).toBe(201);
    projectIds.push(result.body.project.id);
    expect(result.body.project.role).toBe("OWNER");
    expect(
      result.body.project.files.find((f: { path: string }) =>
        f.path.endsWith(".png"),
      ),
    ).toMatchObject({
      encoding: "base64",
      mimeType: "image/png",
      content: "AA==",
    });
    const invalid = await request(app)
      .post("/api/projects/import")
      .set("Cookie", ownerCookie)
      .set("Origin", config.WEB_ORIGIN)
      .send({ name: "Invalid", files: [{ path: "a" }, { path: "a/c" }] });
    expect(invalid.status).toBe(400);
    const viewer = await request(app)
      .get("/api/projects")
      .set("Cookie", viewerCookie);
    expect(viewer.body.projects[0].role).toBe("VIEWER");
  });
  it("renames and deletes with optimistic versions, including conflict recovery", async () => {
    const projectId = projectIds[1];
    const file = await db.file.findFirstOrThrow({
      where: { projectId, path: "main.tex" },
    });
    const route = `/api/projects/${projectId}/files/${file.id}`;
    const rename = await request(app)
      .patch(route)
      .set("Cookie", ownerCookie)
      .set("Origin", config.WEB_ORIGIN)
      .send({ path: "chapters/start.tex", version: 0 });
    expect(rename.status).toBe(200);
    expect(rename.body.file).toMatchObject({
      path: "chapters/start.tex",
      version: 1,
    });
    const stale = await request(app)
      .delete(`${route}?version=0`)
      .set("Cookie", ownerCookie)
      .set("Origin", config.WEB_ORIGIN);
    expect(stale.status).toBe(409);
    expect(stale.body.file).toMatchObject({
      path: "chapters/start.tex",
      version: 1,
    });
    expect(
      (
        await request(app)
          .delete(route)
          .set("Cookie", ownerCookie)
          .set("Origin", config.WEB_ORIGIN)
      ).status,
    ).toBe(400);
    for (const cookie of [viewerCookie, otherCookie])
      expect(
        (
          await request(app)
            .patch(route)
            .set("Cookie", cookie)
            .set("Origin", config.WEB_ORIGIN)
            .send({ path: "stolen.tex", version: 1 })
        ).status,
      ).toBe(404);
    expect(
      (
        await request(app)
          .delete(`${route}?version=1`)
          .set("Cookie", ownerCookie)
          .set("Origin", config.WEB_ORIGIN)
      ).status,
    ).toBe(204);
  });
  it("rejects parent collisions even when file creations race", async () => {
    const route = `/api/projects/${projectIds[1]}/files`;
    const responses = await Promise.all(
      ["collision", "collision/nested.tex"].map((path) =>
        request(app)
          .post(route)
          .set("Cookie", ownerCookie)
          .set("Origin", config.WEB_ORIGIN)
          .send({ path }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    const binary = await db.file.findFirstOrThrow({
      where: { projectId: projectIds[1], encoding: "base64" },
    });
    expect(
      (
        await request(app)
          .put(`${route}/${binary.id}`)
          .set("Cookie", ownerCookie)
          .set("Origin", config.WEB_ORIGIN)
          .send({ content: "corrupted", version: 0 })
      ).status,
    ).toBe(400);
  });
  it("lets the owner delete a project and removes its files", async () => {
    const id = projectIds[0];
    expect(
      (
        await request(app)
          .delete(`/api/projects/${id}`)
          .set("Cookie", ownerCookie)
          .set("Origin", config.WEB_ORIGIN)
      ).status,
    ).toBe(204);
    expect(await db.file.count({ where: { projectId: id } })).toBe(0);
  });
});
