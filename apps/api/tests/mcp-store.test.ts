import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createPrismaTokenStore } from "../src/mcp/prisma-tokens.js";
import { authenticateToken, hashToken } from "../src/mcp/tokens.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Use a dedicated migrated _test database");
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
});
const store = createPrismaTokenStore(db);
const owner = randomUUID();
const second = randomUUID();
describe("PAT issuance and revocation against real Postgres", () => {
  beforeAll(async () => {
    for (const id of [owner, second])
      await db.user.create({
        data: { id, name: "PAT owner", email: `${id}@example.test` },
      });
  });
  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: [owner, second] } } });
    await db.$disconnect();
  });
  it("serializes concurrent creation so the per-user active count never exceeds the cap", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) =>
        store.create(
          {
            userId: owner,
            label: `Concurrent ${i}`,
            tokenHash: hashToken(randomUUID()),
            scopes: ["files:read"],
            projectIds: ["p"],
            expiresAt: new Date(Date.now() + 60_000),
            revokedAt: null,
          },
          20,
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(20);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(5);
    expect(
      await db.accessToken.count({ where: { userId: owner, revokedAt: null } }),
    ).toBe(20);
    const tokens = await store.list(owner);
    expect(await store.revoke(second, tokens[0].id)).toBe(false);
    expect(await store.revoke(owner, tokens[0].id)).toBe(true);
    await expect(
      store.create(
        {
          userId: owner,
          label: "Replacement",
          tokenHash: hashToken(randomUUID()),
          scopes: ["files:read"],
          projectIds: ["p"],
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: null,
        },
        20,
      ),
    ).resolves.toMatchObject({ userId: owner });
  });
  it("validates expiry and revocation from persisted hashes on every authentication", async () => {
    const raw = `lf_pat_${"z".repeat(43)}`;
    const token = await store.create(
      {
        userId: second,
        label: "Lifecycle",
        tokenHash: hashToken(raw),
        scopes: ["files:read"],
        projectIds: ["p"],
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
      20,
    );
    expect((await authenticateToken(store, `Bearer ${raw}`))?.id).toBe(
      token.id,
    );
    await db.accessToken.update({
      where: { id: token.id },
      data: { expiresAt: new Date(0) },
    });
    expect(await authenticateToken(store, `Bearer ${raw}`)).toBeNull();
    await db.accessToken.update({
      where: { id: token.id },
      data: { expiresAt: new Date(Date.now() + 60_000) },
    });
    await store.revoke(second, token.id);
    expect(await authenticateToken(store, `Bearer ${raw}`)).toBeNull();
    expect(
      (await db.accessToken.findUniqueOrThrow({ where: { id: token.id } }))
        .tokenHash,
    ).toBe(hashToken(raw));
  });
});
