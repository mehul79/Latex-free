import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { parse } from "dotenv";
import { test, expect, type BrowserContext } from "@playwright/test";

test("account file discussions support replies, moderation and viewer access", async ({
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
    const owner = await account("Discussion owner");
    const editor = await account("Discussion editor");
    const viewer = await account("Discussion viewer");
    const project = await db.project.create({
      data: {
        name: "Browser discussion fixture",
        members: {
          create: userIds.map((userId, i) => ({
            userId,
            role: (["OWNER", "EDITOR", "VIEWER"] as const)[i],
          })),
        },
        files: {
          create: { path: "main.tex", content: "Discussion manuscript." },
        },
      },
    });
    projectIds.push(project.id);
    const path = `/projects/${project.id}`;
    async function open(page: typeof owner.page) {
      await page.goto(path);
      await expect(
        page.getByText(/Account workspace · live · synchronized/),
      ).toBeVisible();
      await page.getByRole("button", { name: "Comments", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Comments · main.tex", exact: true }),
      ).toBeVisible();
    }
    await open(owner.page);
    await owner.page
      .getByLabel("New discussion", { exact: true })
      .fill("Please review <script>window.commentExecuted=true</script>");
    await owner.page
      .getByRole("button", { name: "Post comment", exact: true })
      .click();
    await expect(
      owner.page.getByText(
        "Please review <script>window.commentExecuted=true</script>",
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      await owner.page.evaluate(
        () =>
          (window as Window & { commentExecuted?: boolean }).commentExecuted,
      ),
    ).toBeUndefined();
    await open(editor.page);
    await editor.page
      .getByLabel("Reply", { exact: true })
      .fill("I reviewed the manuscript.");
    await editor.page
      .getByRole("button", { name: "Post reply", exact: true })
      .click();
    await expect(
      editor.page.getByText("I reviewed the manuscript.", { exact: true }),
    ).toBeVisible();
    await expect(
      editor.page.getByRole("button", { name: "Edit comment", exact: true }),
    ).toHaveCount(1);
    await editor.page
      .getByRole("button", { name: "Edit comment", exact: true })
      .click();
    await editor.page
      .getByLabel("Edit comment", { exact: true })
      .fill("Review completed.");
    await editor.page
      .getByRole("button", { name: "Save comment", exact: true })
      .click();
    await expect(
      editor.page.getByText("Review completed.", { exact: true }),
    ).toBeVisible();
    await owner.page
      .getByRole("button", { name: "Refresh comments", exact: true })
      .click();
    await expect(
      owner.page.getByText("Review completed.", { exact: true }),
    ).toBeVisible();
    await owner.page
      .getByRole("button", { name: "Resolve discussion", exact: true })
      .click();
    await expect(
      owner.page.getByRole("button", {
        name: "Reopen discussion",
        exact: true,
      }),
    ).toBeVisible();
    await open(viewer.page);
    await expect(
      viewer.page.getByText("Review completed.", { exact: true }),
    ).toBeVisible();
    await expect(
      viewer.page.getByText("Viewer access: read discussions.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      viewer.page.getByLabel("New discussion", { exact: true }),
    ).toHaveCount(0);
    await expect(
      viewer.page.getByRole("button", { name: "Post reply", exact: true }),
    ).toHaveCount(0);
    await expect(
      viewer.page.getByRole("button", { name: "Edit comment", exact: true }),
    ).toHaveCount(0);
    await expect(
      viewer.page.getByRole("button", {
        name: "Reopen discussion",
        exact: true,
      }),
    ).toHaveCount(0);
    await viewer.page.setViewportSize({ width: 390, height: 844 });
    expect(
      await viewer.page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await viewer.page.keyboard.press("Escape");
    expect(
      await viewer.page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await owner.page.setViewportSize({ width: 390, height: 844 });
    await owner.page.keyboard.press("Escape");
    expect(
      await owner.page
        .locator(".editor-header-actions button")
        .evaluateAll((buttons) =>
          buttons.every((button) => {
            const bounds = button.getBoundingClientRect();
            return bounds.left >= 0 && bounds.right <= window.innerWidth;
          }),
        ),
    ).toBe(true);
    await owner.page
      .getByRole("button", { name: "Comments", exact: true })
      .click();
    await owner.page
      .getByRole("button", { name: "Reopen discussion", exact: true })
      .click();
    await expect(
      owner.page.getByRole("button", {
        name: "Resolve discussion",
        exact: true,
      }),
    ).toBeVisible();
    const discussion = owner.page.getByRole("article");
    owner.page.once("dialog", (dialog) => dialog.accept());
    await discussion
      .getByRole("button", { name: "Delete comment", exact: true })
      .last()
      .click();
    await expect(
      owner.page.getByText("Review completed.", { exact: true }),
    ).toHaveCount(0);
    expect(
      await db.comment.count({ where: { thread: { projectId: project.id } } }),
    ).toBe(1);
    await owner.page.reload();
    await expect(
      owner.page.getByText(/Account workspace · live · synchronized/),
    ).toBeVisible();
    await owner.page
      .getByRole("button", { name: "Comments", exact: true })
      .click();
    await expect(
      owner.page.getByText(
        "Please review <script>window.commentExecuted=true</script>",
        { exact: true },
      ),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await db.project.deleteMany({ where: { id: { in: projectIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  }
});
