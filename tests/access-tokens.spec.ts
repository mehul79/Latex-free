import { expect, test } from "@playwright/test";

test("local account settings explains sign-in without creating tokens", async ({
  page,
}) => {
  let tokenRequests = 0;
  await page.route("**/api/auth/get-session**", (route) =>
    route.fulfill({ json: null }),
  );
  await page.route("**/api/tokens**", (route) => {
    tokenRequests++;
    return route.fulfill({ json: { tokens: [] } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Account settings", exact: true })
    .click();
  await expect(
    page.getByText(
      "Sign in to create access tokens for your account projects.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "New token" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Sign in with Google", exact: true }),
  ).toBeVisible();
  expect(tokenRequests).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("token creation is explicitly scoped, ephemeral, and revocable", async ({
  page,
}) => {
  // All authentication and token values below are isolated test fixtures.
  const accountId = "token-ui-fixture-user";
  const secret = "fixture-only-token-not-a-real-credential";
  const timestamp = "2026-11-01T00:00:00Z";
  const metadata = {
    id: "fixture-token-id",
    userId: accountId,
    label: "Research assistant",
    scopes: ["projects:read", "files:read"],
    projectIds: ["fixture-project"],
    createdAt: timestamp,
    expiresAt: "2099-01-01T00:00:00Z",
    revokedAt: null,
  };
  let created = false;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Clipboard unavailable in fixture");
        },
      },
    });
  });
  await page.route("**/api/auth/get-session**", (route) =>
    route.fulfill({
      json: {
        user: {
          id: accountId,
          name: "Token UI fixture",
          email: "token-ui@example.test",
          emailVerified: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        session: {
          id: "fixture-session",
          userId: accountId,
          expiresAt: "2099-01-01T00:00:00Z",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }),
  );
  await page.route("**/api/projects", (route) =>
    route.fulfill({
      json: {
        projects: [
          {
            id: "fixture-project",
            name: "Allowed research",
            template: "blank",
            starred: false,
            mainFile: "main.tex",
            engine: "pdflatex",
            role: "OWNER",
            createdAt: timestamp,
            updatedAt: timestamp,
            files: [],
          },
        ],
      },
    }),
  );
  await page.route("**/api/tokens", async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({
        label: "Research assistant",
        scopes: ["projects:read", "files:read"],
        projectIds: ["fixture-project"],
        expiresInDays: 7,
      });
      created = true;
      await route.fulfill({ status: 201, json: { token: secret, metadata } });
    } else await route.fulfill({ json: { tokens: created ? [metadata] : [] } });
  });
  await page.route("**/api/tokens/fixture-token-id", (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.goto("/");
  await expect(
    page.getByText("Connected account", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Account settings", exact: true })
    .click();
  await page.getByRole("button", { name: "New token", exact: true }).click();
  await page.getByLabel("Token name").fill("Research assistant");
  await expect(
    page.getByLabel("Read project details", { exact: true }),
  ).toBeChecked();
  await expect(page.getByLabel("Read files", { exact: true })).toBeChecked();
  await expect(
    page.getByLabel("Edit files", { exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByLabel("Manage project sharing", { exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Create token", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Allowed research", { exact: true }).check();
  await page.getByLabel("Expires after").selectOption("7");
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  await expect(page.getByLabel("Created access token")).toHaveValue(secret);
  await page.getByRole("button", { name: "Copy token", exact: true }).click();
  await expect(page.getByText(/Clipboard access failed/)).toBeVisible();
  expect(
    await page.evaluate(
      (value) =>
        !JSON.stringify(localStorage).includes(value) &&
        !JSON.stringify(sessionStorage).includes(value),
      secret,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "I have saved my token", exact: true })
    .click();
  await expect(page.getByLabel("Created access token")).toHaveCount(0);
  await expect(
    page.getByText("Research assistant", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("button", { name: "Keep token", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Revoke", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("button", { name: "Revoke token", exact: true }).click();
  await expect(page.getByText(/Revoked · 1 project/)).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Account settings", exact: true })
    .click();
  await expect(page.getByLabel("Created access token")).toHaveCount(0);
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
});
