import { test, expect } from "@playwright/test";
test("create, edit, persist, export, organize, and delete a local project", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Academic article", exact: false })
    .click();
  await page.getByLabel("Project name", { exact: true }).fill("My first paper");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects\//);
  await expect(
    page.getByRole("heading", { name: "My first paper", exact: true }),
  ).toBeVisible();
  const source = page.locator(".cm-content");
  await source.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nA persistent idea.");
  await expect(source).toContainText("A persistent idea.");
  await page.reload();
  await expect(source).toContainText("A persistent idea.");
  await page.getByRole("button", { name: "Add file", exact: true }).click();
  await page.getByLabel("File path").fill("sections/notes.tex");
  await page.getByRole("button", { name: "Create file", exact: true }).click();
  await expect(page.locator(".active-file-tab")).toContainText(
    "sections/notes.tex",
  );
  await source.click();
  await page.keyboard.type("Notes for later.");
  await page.getByRole("button", { name: "Export", exact: false }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download current file" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("notes.tex");
  await page.getByRole("link", { name: "Back to projects" }).click();
  await page
    .getByRole("button", { name: "Star My first paper", exact: true })
    .click();
  await page.getByRole("button", { name: "Starred", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "My first paper", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search projects").fill("missing");
  await expect(
    page.getByRole("heading", { name: "No projects found." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear search", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "List view" }).click();
  await expect(page.locator(".project-card-list")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Options for My first paper" })
    .click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill("A better name");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "A better name", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Options for A better name" }).click();
  await page
    .getByRole("menuitem", { name: "Delete project", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "A place for your favorites." }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("mobile dashboard fits and navigation works", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Big ideas start here." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Templates", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A good place to begin." }),
  ).toBeVisible();
});
