import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

test("prepare real engine, compile new nested PDFs offline, and preserve source on failure", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(240000);
  let compileRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/compile") compileRequests++;
  });
  const main = String.raw`\documentclass{article}
\usepackage{graphicx}
\usepackage{geometry}
\usepackage{hyperref}
\usepackage{amsmath}
\begin{document}
\input{section}
\includegraphics[width=1cm]{pixel.png}
\end{document}`;
  await page.addInitScript(
    ({ main }) => {
      localStorage.setItem(
        "latex-free-workspace-v1",
        JSON.stringify({
          version: 0,
          state: {
            localProjects: [
              {
                id: "offline-proof",
                name: "Offline proof",
                template: "blank",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                files: [
                  {
                    id: "main",
                    path: "nested/main.tex",
                    content: main,
                    encoding: "utf8",
                    version: 0,
                  },
                  {
                    id: "section",
                    path: "nested/section.tex",
                    content: "OfflineFirstUniqueMarker",
                    encoding: "utf8",
                    version: 0,
                  },
                  {
                    id: "pixel",
                    path: "nested/pixel.png",
                    content:
                      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
                    encoding: "base64",
                    version: 0,
                  },
                ],
              },
            ],
            view: "grid",
            sort: "updated",
          },
        }),
      );
    },
    { main },
  );
  await page.goto("/projects/offline-proof");
  await page.getByLabel("Compiler source").selectOption("browser");
  await page.getByRole("button", { name: "Prepare offline compiler" }).click();
  await expect(
    page.getByText("Offline compiler ready · stored in this browser"),
  ).toBeVisible({ timeout: 120000 });
  await context.setOffline(true);
  async function compilePdf(label: string) {
    await page.getByRole("button", { name: "Compile", exact: true }).click();
    await expect
      .poll(
        async () => {
          const alert = await page.getByRole("alert").allTextContents();
          if (alert.some((text) => text.includes("Exception during")))
            throw new Error(alert.join("\n"));
          return await page
            .getByText("Compilation complete", { exact: false })
            .first()
            .isVisible();
        },
        { timeout: 70000 },
      )
      .toBe(true);
    await expect(page.getByRole("img", { name: "PDF page 1" })).toBeVisible({
      timeout: 30000,
    });
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "PDF", exact: true }).click();
    const download = await pending;
    const target = testInfo.outputPath(`${label}.pdf`);
    await download.saveAs(target);
    return {
      hash: createHash("sha256")
        .update(await readFile(target))
        .digest("hex"),
      text: execFileSync("pdftotext", [target, "-"], { encoding: "utf8" }),
    };
  }
  const first = await compilePdf("first-offline");
  expect(first.text).toContain("OfflineFirstUniqueMarker");
  await page.getByRole("button", { name: "section.tex", exact: true }).click();
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("OfflineSecondUniqueMarker");
  const second = await compilePdf("second-offline");
  expect(second.text).toContain("OfflineSecondUniqueMarker");
  expect(second.hash).not.toBe(first.hash);
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("\\DefinitelyUndefinedOfflineCommand");
  await page.getByRole("button", { name: "Compile", exact: true }).click();
  await expect(
    page.getByText("Compilation failed", { exact: false }).first(),
  ).toBeVisible({ timeout: 70000 });
  await expect(editor).toContainText("DefinitelyUndefinedOfflineCommand");
  await expect(
    page.getByText("Showing the previous successful PDF.", { exact: false }),
  ).toBeVisible();
  expect(compileRequests).toBe(0);
});
