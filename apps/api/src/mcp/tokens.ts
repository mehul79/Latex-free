import { createHash, randomBytes } from "node:crypto";
import express, { type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {
  TOKEN_SCOPES,
  type AccessTokenRecord,
  type TokenStore,
} from "./contracts.js";

export function hashToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function publicToken({
  tokenHash: _hash,
  ...record
}: AccessTokenRecord) {
  void _hash;
  return record;
}
export async function authenticateToken(
  store: TokenStore,
  authorization: string | undefined,
  now = new Date(),
) {
  const match = /^Bearer (lf_pat_[A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
  if (!match) return null;
  const token = await store.findByHash(hashToken(match[1]));
  if (!token || token.revokedAt || token.expiresAt <= now) return null;
  return token;
}
const createSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    scopes: z.array(z.enum(TOKEN_SCOPES)).min(1).max(TOKEN_SCOPES.length),
    projectIds: z.array(z.string().min(1).max(128)).min(1).max(100),
    expiresInDays: z.number().int().min(1).max(90).default(30),
  })
  .strict();
export function createTokenRouter(options: {
  tokens: TokenStore;
  trustedOrigin: string;
  getSessionUserId(req: Request): Promise<string | null>;
  canAccessProject(userId: string, projectId: string): Promise<boolean>;
}) {
  const router = express.Router();
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 30,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  router.use(async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers.origin !== options.trustedOrigin
    ) {
      res.status(403).json({ error: "Untrusted origin" });
      return;
    }
    const userId = await options.getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Sign in to manage tokens" });
      return;
    }
    res.locals.tokenUserId = userId;
    next();
  });
  router.use(express.json({ limit: "16kb" }));
  router.get("/", async (_req, res) => {
    res.json({
      tokens: (await options.tokens.list(res.locals.tokenUserId)).map(
        publicToken,
      ),
    });
  });
  router.post("/", async (req, res) => {
    if (Buffer.byteLength(JSON.stringify(req.body ?? null)) > 16_384) {
      res.status(413).json({ error: "Request too large" });
      return;
    }
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid token settings" });
      return;
    }
    const input = parsed.data;
    const projectIds = [...new Set(input.projectIds)];
    for (const projectId of projectIds) {
      if (
        !(await options.canAccessProject(res.locals.tokenUserId, projectId))
      ) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
    }
    const plaintext = `lf_pat_${randomBytes(32).toString("base64url")}`;
    const record = await options.tokens.create(
      {
        userId: res.locals.tokenUserId,
        label: input.label,
        tokenHash: hashToken(plaintext),
        scopes: [...new Set(input.scopes)],
        projectIds,
        expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000),
        revokedAt: null,
      },
      20,
    );
    res.status(201).json({ token: plaintext, metadata: publicToken(record) });
  });
  router.delete("/:id", async (req, res) => {
    if (
      !(await options.tokens.revoke(
        res.locals.tokenUserId,
        String(req.params.id),
      ))
    ) {
      res.status(404).json({ error: "Token not found" });
      return;
    }
    res.status(204).end();
  });
  return router;
}
