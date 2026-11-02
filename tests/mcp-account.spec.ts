import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { parse } from "dotenv";
import { test, expect, type BrowserContext } from "@playwright/test";

test("account token UI grants scoped live MCP edits and revokes access", async ({
  browser,
}) => {
  test.skip(
    process.env.RUN_ACCOUNT_E2E !== "1",
    "Requires the migrated account API and explicit fixture opt-in",
  );
  test.setTimeout(90_000);
  const apiRequire = createRequire(resolve("apps/api/package.json"));
  const { makeSignature } = await import(
    pathToFileURL(apiRequire.resolve("better-auth/crypto")).href
  );
  const fileEnv = parse(await readFile("apps/api/.env"));
  const databaseUrl = process.env.DATABASE_URL ?? fileEnv.DATABASE_URL;
  const secret = process.env.BETTER_AUTH_SECRET ?? fileEnv.BETTER_AUTH_SECRET;
  if (!databaseUrl || !secret)
    throw new Error(
      "Account E2E requires API database and session configuration",
    );
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const userIds: string[] = [];
  const projectIds: string[] = [];
  const contexts: BrowserContext[] = [];
  const errors: string[] = [];
  async function account(name: string) {
    const id = randomUUID(),
      token = randomUUID(),
      email = `${id}@example.test`;
    userIds.push(id);
    await db.user.create({
      data: {
        id,
        name,
        email,
        accounts: {
          create: { id: randomUUID(), providerId: "google", accountId: id },
        },
      },
    });
    await db.session.create({
      data: {
        id: randomUUID(),
        token,
        userId: id,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const context = await browser.newContext({
      baseURL: "http://localhost:3000",
    });
    contexts.push(context);
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: encodeURIComponent(
          `${token}.${await makeSignature(token, secret)}`,
        ),
        domain: "localhost",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    return { page, email };
  }
  try {
    const { page } = await account("MCP browser owner");
    const allowedName = `Allowed manuscript ${randomUUID()}`;
    const allowed = await db.project.create({
      data: {
        name: allowedName,
        members: { create: { userId: userIds[0], role: "OWNER" } },
        files: {
          create: { path: "main.tex", content: "Original manuscript." },
        },
      },
      include: { files: true },
    });
    projectIds.push(allowed.id);
    const excluded = await db.project.create({
      data: {
        name: "Excluded manuscript",
        members: { create: { userId: userIds[0], role: "OWNER" } },
      },
    });
    projectIds.push(excluded.id);
    await page.goto("/");
    await expect(
      page.getByText("Connected account", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Account settings", exact: true })
      .click();
    await page.getByRole("button", { name: "New token", exact: true }).click();
    await page.getByLabel("Token name").fill("Browser MCP check");
    await page.getByLabel("Edit files", { exact: true }).check();
    await page.getByLabel(allowedName, { exact: true }).check();
    await page
      .getByRole("button", { name: "Create token", exact: true })
      .click();
    const tokenField = page.getByLabel("Created access token");
    await expect(tokenField).toBeVisible();
    const token = await tokenField.inputValue();
    expect(token.startsWith("lf_pat_")).toBe(true);
    expect(
      await page.evaluate(
        (value) =>
          !JSON.stringify(localStorage).includes(value) &&
          !JSON.stringify(sessionStorage).includes(value),
        token,
      ),
    ).toBe(true);
    const rpc = (name: string, args: Record<string, unknown> = {}) =>
      page.request.post("http://localhost:4000/mcp", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json, text/event-stream",
        },
        data: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        },
      });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await rpc(name, args);
      expect(response.status()).toBe(200);
      return (await response.json()).result;
    };
    const tools = await page.request.post("http://localhost:4000/mcp", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
      },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(tools.status()).toBe(200);
    expect((await tools.json()).result.tools).toHaveLength(10);
    const listed = await call("list_projects");
    const projects = JSON.parse(listed.content[0].text) as { id: string }[];
    expect(projects.map((project) => project.id)).toEqual([allowed.id]);
    const fileArgs = { projectId: allowed.id, fileId: allowed.files[0].id };
    const read = await call("read_file", fileArgs);
    expect(JSON.parse(read.content[0].text).content).toBe(
      "Original manuscript.",
    );
    expect((await call("list_files", { projectId: excluded.id })).isError).toBe(
      true,
    );
    expect(
      (
        await call("share_project", {
          projectId: allowed.id,
          email: "nobody@example.test",
          role: "VIEWER",
        })
      ).isError,
    ).toBe(true);
    await page
      .getByRole("button", { name: "I have saved my token", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await page.goto(`/projects/${allowed.id}`);
    await expect(
      page.getByText(/Account workspace · live · synchronized/),
    ).toBeVisible();
    const edit = await call("edit_file", {
      ...fileArgs,
      expectedVersion: 0,
      find: "Original",
      replace: "Updated through MCP",
      expectedMatches: 1,
    });
    expect(edit.isError).not.toBe(true);
    await expect(page.locator(".cm-content")).toContainText(
      "Updated through MCP manuscript.",
    );
    expect(
      (await db.file.findUniqueOrThrow({ where: { id: allowed.files[0].id } }))
        .content,
    ).toBe("Updated through MCP manuscript.");
    await page.goto("/");
    await expect(
      page.getByText("Connected account", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Account settings", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Account settings", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Created access token")).toHaveCount(0);
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await page
      .getByRole("button", { name: "Revoke token", exact: true })
      .click();
    await expect(page.getByText(/Revoked · 1 project/)).toBeVisible();
    expect((await rpc("read_file", fileArgs)).status()).toBe(401);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await db.project.deleteMany({ where: { id: { in: projectIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  }
});
