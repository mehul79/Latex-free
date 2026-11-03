import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";

test("local Trash retains text and binary files across reload, restores collisions by path, and exports only active files", async ({
  page,
}) => {
  const binary =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  await page.addInitScript(
    ({ binary }) => {
      if (localStorage.getItem("latex-free-workspace-v1")) return;
      localStorage.setItem(
        "latex-free-workspace-v1",
        JSON.stringify({
          version: 0,
          state: {
            localProjects: [
              {
                id: "trash-proof",
                name: "Trash proof",
                template: "blank",
                starred: false,
                updatedAt: new Date().toISOString(),
                files: [
                  {
                    id: "text-original",
                    path: "main.tex",
                    content: "Retained text marker",
                    encoding: "utf8",
                    version: 0,
                  },
                  {
                    id: "image-original",
                    path: "assets/pixel.png",
                    content: binary,
                    encoding: "base64",
                    mimeType: "image/png",
                    version: 0,
                  },
                ],
              },
            ],
            localTrash: {},
            view: "grid",
            sort: "updated",
          },
        }),
      );
    },
    { binary },
  );
  await page.goto("/projects/trash-proof");
  async function trash(path: string) {
    await page
      .getByRole("button", { name: `Options for ${path}`, exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Move to Trash", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Move to Trash", exact: true })
      .click();
  }
  await trash("main.tex");
  await trash("assets/pixel.png");
  await page.reload();
  await page.getByRole("button", { name: "File Trash", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Restore main.tex", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Restore assets/pixel.png", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Add file", exact: true })
    .first()
    .click();
  await page.getByLabel("File path", { exact: true }).fill("main.tex");
  await page.getByRole("button", { name: "Create file", exact: true }).click();
  async function exported(name: string) {
    await page.getByRole("button", { name: "Export", exact: false }).click();
    const pending = page.waitForEvent("download");
    await page.getByRole("menuitem", { name, exact: true }).click();
    return await readFile((await (await pending).path())!);
  }
  const json = JSON.parse(
    (await exported("Download project backup (JSON)")).toString(),
  );
  expect(json.files.map((file: { path: string }) => file.path)).toEqual([
    "main.tex",
  ]);
  expect(json.files[0].content).toBe("");
  const zip = unzipSync(await exported("Download project (ZIP)"));
  expect(Object.keys(zip)).toEqual(["main.tex"]);
  expect(strFromU8(zip["main.tex"])).toBe("");
  await page.getByRole("button", { name: "File Trash", exact: true }).click();
  await page
    .getByRole("button", { name: "Restore main.tex", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Restore path collides" }),
  ).toBeVisible();
  await page
    .getByLabel("Restore path for main.tex", { exact: true })
    .fill("recovered/main.tex");
  await page
    .getByRole("button", { name: "Restore main.tex", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Restore main.tex", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Restore assets/pixel.png", exact: true })
    .click();
  await expect(
    page.getByText("Trash is empty.", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const stored = await page.evaluate(
    () => JSON.parse(localStorage.getItem("latex-free-workspace-v1")!).state,
  );
  const files = stored.localProjects[0].files;
  expect(
    files.find((f: { id: string }) => f.id === "text-original"),
  ).toMatchObject({
    path: "recovered/main.tex",
    content: "Retained text marker",
    version: 2,
  });
  expect(
    files.find((f: { id: string }) => f.id === "image-original"),
  ).toMatchObject({
    path: "assets/pixel.png",
    content: binary,
    encoding: "base64",
    mimeType: "image/png",
    version: 2,
  });
  expect(stored.localTrash["trash-proof"]).toEqual([]);
  await page.reload();
  await page.locator('button[title="recovered/main.tex"]').click();
  await expect(page.locator(".cm-content")).toContainText(
    "Retained text marker",
  );
});
