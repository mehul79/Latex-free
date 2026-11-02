import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { parse } from "dotenv";
import { test, expect, type BrowserContext } from "@playwright/test";

test("account sharing, role changes, autosave, and history restore", async ({
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
    const owner = await account("Browser owner");
    const collaborator = await account("Browser collaborator");
    await owner.page.goto("/");
    await expect(
      owner.page.getByText("Connected account", { exact: true }),
    ).toBeVisible();
    await owner.page
      .getByRole("button", { name: "Academic article", exact: false })
      .click();
    await owner.page
      .getByLabel("Project name", { exact: true })
      .fill(`Sharing check ${randomUUID()}`);
    const created = owner.page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/projects") &&
        response.request().method() === "POST",
    );
    await owner.page
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    const result = await (await created).json();
    projectIds.push(result.project.id);
    const projectPath = `/projects/${result.project.id}`;
    const fileId = result.project.files[0].id;
    const initialContent = result.project.files[0].content;
    await expect(owner.page.getByText("Owner", { exact: true })).toBeVisible();
    await owner.page
      .getByRole("button", { name: "Share", exact: true })
      .click();
    await owner.page
      .getByLabel("Google account email")
      .fill(collaborator.email);
    await owner.page.getByLabel("New member role").selectOption("VIEWER");
    await owner.page
      .getByRole("button", { name: "Add member", exact: true })
      .click();
    await expect(
      owner.page.getByLabel(`Role for ${collaborator.email}`),
    ).toHaveValue("VIEWER");
    await owner.page.keyboard.press("Escape");

    await collaborator.page.goto(projectPath);
    await expect(
      collaborator.page.getByText("Viewer", { exact: true }),
    ).toBeVisible();
    await expect(
      collaborator.page.getByRole("button", { name: "Save", exact: true }),
    ).toBeDisabled();
    await expect(collaborator.page.locator(".cm-content")).toHaveAttribute(
      "contenteditable",
      "false",
    );
    await expect(
      collaborator.page.getByRole("button", { name: "Share", exact: true }),
    ).toHaveCount(0);
    await collaborator.page
      .getByRole("button", { name: "History", exact: true })
      .click();
    await collaborator.page
      .getByRole("button", { name: /Version 0 ·/ })
      .click();
    await expect(collaborator.page.getByLabel("Revision preview")).toHaveText(
      initialContent,
    );
    await expect(
      collaborator.page.getByRole("button", {
        name: "Restore this version",
        exact: true,
      }),
    ).toHaveCount(0);
    await collaborator.page.keyboard.press("Escape");

    await owner.page
      .getByRole("button", { name: "Share", exact: true })
      .click();
    await owner.page
      .getByLabel(`Role for ${collaborator.email}`)
      .selectOption("EDITOR");
    await expect
      .poll(
        async () =>
          (
            await db.membership.findUniqueOrThrow({
              where: {
                userId_projectId: {
                  userId: userIds[1],
                  projectId: projectIds[0],
                },
              },
            })
          ).role,
      )
      .toBe("EDITOR");
    await owner.page.keyboard.press("Escape");
    await collaborator.page.reload();
    await expect(
      collaborator.page.getByText("Editor", { exact: true }),
    ).toBeVisible();
    const editedContent = `${initialContent}\n% A collaborator saved this version.\n`;
    await collaborator.page.locator(".cm-content").fill(editedContent);
    await expect
      .poll(
        async () =>
          (await db.file.findUniqueOrThrow({ where: { id: fileId } })).content,
      )
      .toBe(editedContent);
    await expect(collaborator.page.locator(".save-status")).toHaveText("Saved");
    await owner.page.reload();
    await expect(owner.page.locator(".cm-content")).toContainText(
      "A collaborator saved this version.",
    );
    await owner.page
      .getByRole("button", { name: "History", exact: true })
      .click();
    await expect(
      owner.page.getByRole("button", { name: /Version 1 ·/ }),
    ).toBeVisible();
    await owner.page.getByRole("button", { name: /Version 0 ·/ }).click();
    await expect(owner.page.getByLabel("Revision preview")).toHaveText(
      initialContent,
    );
    owner.page.once("dialog", (dialog) => dialog.accept());
    await owner.page
      .getByRole("button", { name: "Restore this version", exact: true })
      .click();
    await expect(
      owner.page.getByRole("button", { name: /Version 2 · restore/ }),
    ).toBeVisible();
    const restored = await db.file.findUniqueOrThrow({ where: { id: fileId } });
    expect(restored.content).toBe(initialContent);
    expect(restored.version).toBe(2);
    expect(await db.fileRevision.count({ where: { fileId } })).toBe(3);
    await owner.page.keyboard.press("Escape");
    await expect(owner.page.locator(".cm-content")).not.toContainText(
      "A collaborator saved this version.",
    );
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await db.project.deleteMany({ where: { id: { in: projectIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  }
});
