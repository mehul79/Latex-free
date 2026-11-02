import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { parse } from "dotenv";
import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

const initial = "Shared manuscript.\nA paragraph to revise.";
async function fixture(
  browser: Browser,
  run: (data: {
    owner: Page;
    editor: Page;
    editorEmail: string;
    projectId: string;
    fileId: string;
    db: PrismaClient;
  }) => Promise<void>,
) {
  const fileEnv = parse(await readFile("apps/api/.env"));
  const databaseUrl = process.env.DATABASE_URL ?? fileEnv.DATABASE_URL;
  const secret = process.env.BETTER_AUTH_SECRET ?? fileEnv.BETTER_AUTH_SECRET;
  if (!databaseUrl || !secret)
    throw new Error(
      "Collaboration E2E requires configured API database and session signing",
    );
  const apiRequire = createRequire(resolve("apps/api/package.json"));
  const { makeSignature } = await import(
    pathToFileURL(apiRequire.resolve("better-auth/crypto")).href
  );
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const ids: string[] = [],
    projectIds: string[] = [],
    contexts: BrowserContext[] = [],
    errors: string[] = [];
  async function account(name: string) {
    const id = randomUUID(),
      token = randomUUID(),
      email = `${id}@example.test`;
    ids.push(id);
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
    return { page, id, email };
  }
  try {
    const owner = await account("Live owner"),
      editor = await account("Live editor");
    const project = await db.project.create({
      data: {
        name: `Live browser ${randomUUID()}`,
        members: {
          create: [
            { userId: owner.id, role: "OWNER" },
            { userId: editor.id, role: "EDITOR" },
          ],
        },
        files: { create: { path: "main.tex", content: initial } },
      },
      include: { files: true },
    });
    projectIds.push(project.id);
    await Promise.all([
      owner.page.goto(`/projects/${project.id}`),
      editor.page.goto(`/projects/${project.id}`),
    ]);
    for (const page of [owner.page, editor.page]) {
      await expect(page.locator(".cm-content")).toHaveAttribute(
        "contenteditable",
        "true",
      );
      await expect(
        page.getByText(/Account workspace · live · synchronized/),
      ).toBeVisible();
    }
    await run({
      owner: owner.page,
      editor: editor.page,
      editorEmail: editor.email,
      projectId: project.id,
      fileId: project.files[0].id,
      db,
    });
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await db.project.deleteMany({ where: { id: { in: projectIds } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  }
}
// CodeMirror virtualizes rendered lines. Read its full document using the same
// DOM-to-view link as EditorView.findFromDOM, rather than comparing viewports.
const source = async (page: Page) =>
  page.locator(".cm-content").evaluate((element) => {
    const content = element as HTMLElement & {
      cmTile?: { root: { view: { state: { doc: { toString(): string } } } } };
    };
    if (!content.cmTile) throw new Error("CodeMirror document is unavailable");
    return content.cmTile.root.view.state.doc.toString();
  });
async function append(page: Page, text: string) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(text);
}

test("live editors converge through concurrent insert/delete, offline edits, and reload", async ({
  browser,
}) => {
  test.skip(
    process.env.RUN_ACCOUNT_E2E !== "1",
    "Requires real migrated API and signed account fixtures",
  );
  test.setTimeout(90_000);
  await fixture(browser, async ({ owner, editor, db, fileId }) => {
    await Promise.all([
      append(owner, "\nOwner addition."),
      append(editor, "\nEditor addition."),
    ]);
    await expect.poll(() => source(owner)).toContain("Editor addition.");
    await expect.poll(() => source(editor)).toContain("Owner addition.");
    await Promise.all(
      [owner, editor].map(async (page) => {
        await page.locator(".cm-content").click();
        await page.keyboard.press("Control+Home");
        await page.keyboard.press("Delete");
      }),
    );
    await expect
      .poll(async () => (await source(owner)) === (await source(editor)))
      .toBe(true);
    await editor.context().setOffline(true);
    await expect(editor.locator(".save-status")).toContainText("Offline", {
      timeout: 15_000,
    });
    await append(editor, "\nAn offline idea.");
    await append(owner, "\nAn online idea.");
    await editor.context().setOffline(false);
    await expect
      .poll(() => source(owner), { timeout: 20_000 })
      .toContain("An offline idea.");
    await expect.poll(() => source(editor)).toContain("An online idea.");
    await expect
      .poll(async () => (await source(owner)) === (await source(editor)))
      .toBe(true);
    const converged = await source(owner);
    await expect
      .poll(
        async () =>
          (await db.file.findUniqueOrThrow({ where: { id: fileId } })).content,
      )
      .toBe(converged);
    await Promise.all([owner.reload(), editor.reload()]);
    await expect.poll(() => source(owner)).toBe(converged);
    await expect.poll(() => source(editor)).toBe(converged);
  });
});

test("live history restore reaches peers and downgrade/removal locks editing and undo", async ({
  browser,
}) => {
  test.skip(
    process.env.RUN_ACCOUNT_E2E !== "1",
    "Requires real migrated API and signed account fixtures",
  );
  test.setTimeout(90_000);
  await fixture(browser, async ({ owner, editor, editorEmail, db, fileId }) => {
    await append(editor, "\nA saved live edit.");
    await expect.poll(() => source(owner)).toContain("A saved live edit.");
    await expect
      .poll(
        async () =>
          (await db.file.findUniqueOrThrow({ where: { id: fileId } })).version,
      )
      .toBeGreaterThan(0);
    await expect(owner.locator(".save-status")).toHaveText("Saved");
    await owner.getByRole("button", { name: "History", exact: true }).click();
    await owner.getByRole("button", { name: /Version 0 ·/ }).click();
    await expect(owner.getByLabel("Revision preview")).toHaveText(initial);
    const before = await db.file.findUniqueOrThrow({ where: { id: fileId } });
    owner.once("dialog", (dialog) => dialog.accept());
    await owner
      .getByRole("button", { name: "Restore this version", exact: true })
      .click();
    await expect.poll(() => source(editor)).toBe(initial);
    await expect
      .poll(
        async () =>
          (await db.file.findUniqueOrThrow({ where: { id: fileId } })).version,
      )
      .toBe(before.version + 1);
    await owner.keyboard.press("Escape");
    await owner.getByRole("button", { name: "Share", exact: true }).click();
    await owner.getByLabel(`Role for ${editorEmail}`).selectOption("VIEWER");
    await expect(editor.locator(".cm-content")).toHaveAttribute(
      "contenteditable",
      "false",
    );
    await editor.locator(".cm-content").click();
    await editor.keyboard.press("Control+z");
    await editor.keyboard.insertText("Forbidden viewer edit");
    await expect.poll(() => source(editor)).toBe(initial);
    expect(
      (await db.file.findUniqueOrThrow({ where: { id: fileId } })).content,
    ).toBe(initial);
    owner.once("dialog", (dialog) => dialog.accept());
    await owner
      .getByRole("button", { name: `Remove ${editorEmail}`, exact: true })
      .click();
    await expect
      .poll(() => editor.locator('.cm-content[contenteditable="true"]').count())
      .toBe(0);
    await editor.reload();
    await expect(
      editor.getByRole("heading", {
        name: "This project isn’t in your workspace.",
      }),
    ).toBeVisible();
  });
});
