import { test, expect } from "@playwright/test";

test("preparation button supports keyboard retry/cancel, blocks duplicates and respects reduced motion", async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() =>
    localStorage.setItem(
      "latex-free-workspace-v1",
      JSON.stringify({
        version: 0,
        state: {
          localProjects: [
            {
              id: "button-proof",
              name: "Button proof",
              template: "blank",
              starred: false,
              updatedAt: new Date().toISOString(),
              files: [
                {
                  id: "main",
                  path: "main.tex",
                  content: "test",
                  encoding: "utf8",
                  version: 0,
                },
              ],
            },
          ],
          view: "grid",
          sort: "updated",
        },
      }),
    ),
  );
  let downloads = 0;
  let release: (() => void) | undefined;
  await context.route("**/compiler/*/busytex.js", async (route) => {
    downloads++;
    if (downloads === 2) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.abort().catch(() => {});
    } else
      await route.fulfill({
        status: 503,
        body: "Unavailable for this UI failure/cancellation test",
      });
  });
  await page.goto("/projects/button-proof");
  await page.getByLabel("Compiler source").selectOption("browser");
  const idle = page.getByRole("button", {
    name: "Prepare offline compiler (~137 MB)",
    exact: true,
  });
  await expect(idle).toHaveAccessibleName("Prepare offline compiler (~137 MB)");
  await idle.focus();
  await page.keyboard.press("Enter");
  const retry = page.getByRole("button", {
    name: "Retry preparation",
    exact: true,
  });
  await expect(retry).toBeEnabled({ timeout: 30000 });
  await expect(
    page.getByRole("alert").filter({ hasText: "Compiler assets unavailable" }),
  ).toBeVisible();
  await retry.focus();
  await page.keyboard.press("Space");
  const pending = page.getByRole("button", {
    name: "Preparing compiler 0%",
    exact: true,
  });
  await expect(pending).toBeDisabled();
  await expect(pending).toHaveAttribute("aria-busy", "true");
  await expect(pending).toHaveAccessibleName("Preparing compiler 0%");
  await expect(
    page.getByRole("progressbar", { name: "Compiler download progress" }),
  ).toHaveAttribute("value", "0");
  await expect.poll(() => downloads).toBe(2);
  await page.keyboard.press("Enter");
  expect(downloads).toBe(2);
  const reduced = await pending.evaluate((button) => ({
    width: button.style.width,
    svgAnimation: getComputedStyle(button.querySelector("svg")!).animationName,
    transforms: Array.from(button.querySelectorAll("span[style]")).map(
      (span) => getComputedStyle(span).transform,
    ),
  }));
  expect(reduced.width).toBe("");
  expect(reduced.svgAnimation).toBe("none");
  expect(reduced.transforms.every((transform) => transform === "none")).toBe(
    true,
  );
  await page
    .getByRole("button", { name: "Cancel preparation", exact: true })
    .click();
  release?.();
  await expect(idle).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Offline compiler ready", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Compile", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      async () =>
        (await caches.keys()).filter((name) =>
          name.startsWith("latex-free-compiler-"),
        ).length,
    ),
  ).toBe(0);
});
