import { readFile } from "node:fs/promises";
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

test("manage nested files and preserve uploaded assets through ZIP and JSON imports", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Academic article", exact: false })
    .click();
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Archive round trip");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page.getByRole("button", { name: "Add file", exact: true }).click();
  await page.getByLabel("File path").fill("sections/notes.tex");
  await page.getByRole("button", { name: "Create file", exact: true }).click();
  await page.locator(".cm-content").fill("Preserved nested source.");
  await page
    .getByRole("button", {
      name: "Options for sections/notes.tex",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: "Rename or move", exact: true })
    .click();
  await page.getByLabel("File path").fill("chapters/renamed.tex");
  await page.getByRole("button", { name: "Save path", exact: true }).click();
  await expect(page.locator(".active-file-tab")).toContainText(
    "chapters/renamed.tex",
  );
  const folder = page.getByRole("button", { name: "chapters", exact: true });
  await folder.click();
  await expect(
    page.getByRole("button", { name: "renamed.tex", exact: true }),
  ).toBeHidden();
  await folder.click();
  await expect(
    page.getByRole("button", { name: "renamed.tex", exact: true }),
  ).toBeVisible();

  const asset = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=",
    "base64",
  );
  await page
    .getByLabel("Upload project files")
    .setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: asset });
  await expect(
    page.getByRole("img", { name: "pixel.png", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "pixel.png", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "pixel.png", exact: true }),
  ).toBeVisible();
  const assetDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download asset", exact: true })
    .click();
  const downloadedAsset = await assetDownload;
  expect(await readFile((await downloadedAsset.path())!)).toEqual(asset);

  for (const format of ["ZIP", "JSON"]) {
    await page.getByRole("button", { name: "Export", exact: false }).click();
    const pending = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name:
          format === "ZIP"
            ? "Download project (ZIP)"
            : "Download project backup (JSON)",
        exact: true,
      })
      .click();
    const archive = await pending;
    await page.getByRole("link", { name: "Back to projects" }).click();
    await page
      .getByRole("button", { name: "Import project", exact: true })
      .click();
    await page.getByLabel("Project archive").setInputFiles({
      name: archive.suggestedFilename(),
      mimeType: format === "ZIP" ? "application/zip" : "application/json",
      buffer: await readFile((await archive.path())!),
    });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Import project", exact: true })
      .click();
    await expect(page.locator(".file-nav")).toContainText("renamed.tex");
    await page
      .getByRole("button", { name: "renamed.tex", exact: true })
      .click();
    await expect(page.locator(".cm-content")).toContainText(
      "Preserved nested source.",
    );
    await page.getByRole("button", { name: "pixel.png", exact: true }).click();
    await expect(
      page.getByRole("img", { name: "pixel.png", exact: true }),
    ).toBeVisible();
  }
  await page
    .getByRole("button", {
      name: "Options for chapters/renamed.tex",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: "Move to Trash", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Move to Trash", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "chapters", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "renamed.tex", exact: true }),
  ).toHaveCount(0);
});

test("compile a selected entry file into a real PDF", async ({ page }) => {
  test.skip(
    process.env.RUN_COMPILER_E2E !== "1",
    "Requires the API, compiler worker, and TeX Docker image",
  );
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Academic article", exact: false })
    .click();
  await page
    .getByLabel("Project name", { exact: true })
    .fill("A compiled manuscript");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page.getByRole("button", { name: "Add file", exact: true }).click();
  await page.getByLabel("File path").fill("chapters/entry.tex");
  await page.getByRole("button", { name: "Create file", exact: true }).click();
  await page.locator(".cm-content").fill(String.raw`\documentclass{article}
\usepackage[T1]{fontenc}
\title{An open workspace for ideas}
\author{Latex-free}
\begin{document}
\maketitle
\section{A working manuscript}
This PDF was compiled from a nested entry file by an isolated TeX Live container.
\section{From source to paper}
The editor preserves project files while the preview renders the resulting document.
\end{document}`);
  await page.getByLabel("Main TeX file").selectOption("chapters/entry.tex");
  const compiled = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/compile") &&
      response.request().method() === "POST",
    { timeout: 90_000 },
  );
  await page.getByRole("button", { name: "Compile", exact: true }).click();
  const response = await compiled;
  expect(response.ok()).toBe(true);
  const result = await response.json();
  expect(result.status, result.log ?? result.error).toBe("succeeded");
  await expect(
    page.getByText("Compilation complete", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "PDF page 1", exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  const pdf = await pending;
  expect((await readFile((await pdf.path())!)).subarray(0, 5).toString()).toBe(
    "%PDF-",
  );
  await page.screenshot({
    path: "/tmp/latex-editor-milestone.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "PDF preview", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "PDF page 1", exact: true }),
  ).toBeVisible();
  const fitWidth = page.getByRole("button", { name: "Fit width", exact: true });
  await expect(fitWidth).toHaveAttribute("aria-pressed", "true");
  const pdfPage = page.getByRole("img", { name: "PDF page 1", exact: true });
  const fitsViewport = () =>
    pdfPage.evaluate((element) => {
      const container = element.parentElement!;
      const style = getComputedStyle(container);
      return (
        element.getBoundingClientRect().width <=
        container.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight) +
          1
      );
    });
  await expect.poll(fitsViewport).toBe(true);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(fitWidth).toHaveAttribute("aria-pressed", "false");
  await fitWidth.click();
  await expect(fitWidth).toHaveAttribute("aria-pressed", "true");
  await expect.poll(fitsViewport).toBe(true);
  await expect(pdfPage.locator("..")).toHaveAttribute("aria-busy", "false");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/latex-editor-mobile-milestone.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
