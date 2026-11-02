import express, { type Request } from "express";
import type { Prisma, PrismaClient, Role } from "@prisma/client";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { ApiError, authorizeProject } from "../document-service.js";
import { withProject } from "../project-mutex.js";
import { anchorSchema, anchorStatus } from "./anchors.js";

const bodySchema = z
  .object({ body: z.string().trim().min(1).max(5000) })
  .strict();
const threadSchema = bodySchema.extend({ anchor: anchorSchema.optional() });
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(128).optional(),
});
const authorSelect = { id: true, name: true, image: true } as const;
const commentInclude = { author: { select: authorSelect } } as const;
const threadInclude = {
  createdBy: { select: authorSelect },
  resolvedBy: { select: authorSelect },
  comments: {
    include: commentInclude,
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
    take: 200,
  },
} satisfies Prisma.CommentThreadInclude;
const readRoles: Role[] = ["OWNER", "EDITOR", "VIEWER"];
const writeRoles: Role[] = ["OWNER", "EDITOR"];

export function createCommentsRouter(options: {
  prisma: PrismaClient;
  trustedOrigin: string;
  getSessionUserId(req: Request): Promise<string | null>;
}) {
  const { prisma } = options;
  const router = express.Router({ mergeParams: true });
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
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
      res.status(401).json({ error: "Sign in to access comments" });
      return;
    }
    res.locals.commentActorId = userId;
    next();
  });
  router.use(express.json({ limit: "16kb" }));
  router.use((req, res, next) => {
    if (Buffer.byteLength(JSON.stringify(req.body ?? null)) > 16_384) {
      res.status(413).json({ error: "Request too large" });
      return;
    }
    next();
  });
  const access = async (
    tx: Prisma.TransactionClient,
    actorId: string,
    projectId: string,
    fileId: string,
    roles: Role[],
  ) => {
    const member = await authorizeProject(tx, projectId, actorId, roles);
    const file = await tx.file.findFirst({ where: { id: fileId, projectId } });
    if (!file || file.encoding !== "utf8")
      throw new ApiError(404, "Text file not found");
    return { member, file };
  };
  router.get("/threads", async (req, res) => {
    const query = querySchema.parse(req.query);
    const actorId = res.locals.commentActorId as string;
    const projectId = String((req.params as Record<string, string>).projectId),
      fileId = String((req.params as Record<string, string>).fileId);
    const result = await withProject(projectId, () =>
      prisma.$transaction(async (tx) => {
        const { file } = await access(
          tx,
          actorId,
          projectId,
          fileId,
          readRoles,
        );
        const cursor = query.cursor
          ? await tx.commentThread.findFirst({
              where: { id: query.cursor, projectId, fileId },
            })
          : null;
        if (query.cursor && !cursor)
          throw new ApiError(400, "Invalid thread cursor");
        const candidates = await tx.commentThread.findMany({
          where: { projectId, fileId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
          take: query.limit + 1,
          include: threadInclude,
        });
        const threads = [];
        let bytes = 0;
        for (const thread of candidates.slice(0, query.limit)) {
          const dto = {
            ...thread,
            anchorStatus: anchorStatus(file, thread.anchor),
          };
          const size = Buffer.byteLength(JSON.stringify(dto));
          if (threads.length && bytes + size > 2_000_000) break;
          threads.push(dto);
          bytes += size;
        }
        return {
          threads,
          nextCursor:
            candidates.length > threads.length
              ? (threads.at(-1)?.id ?? null)
              : null,
        };
      }),
    );
    res.json(result);
  });
  router.post("/threads", async (req, res) => {
    const input = threadSchema.parse(req.body);
    const actorId = res.locals.commentActorId as string;
    const projectId = String((req.params as Record<string, string>).projectId),
      fileId = String((req.params as Record<string, string>).fileId);
    const thread = await withProject(projectId, () =>
      prisma.$transaction(async (tx) => {
        const { file } = await access(
          tx,
          actorId,
          projectId,
          fileId,
          writeRoles,
        );
        const status = anchorStatus(file, input.anchor, true);
        if ((await tx.commentThread.count({ where: { projectId } })) >= 1000)
          throw new ApiError(409, "Project has reached the discussion limit");
        const created = await tx.commentThread.create({
          data: {
            projectId,
            fileId,
            createdById: actorId,
            ...(input.anchor ? { anchor: input.anchor } : {}),
            comments: { create: { authorId: actorId, body: input.body } },
          },
          include: threadInclude,
        });
        return { ...created, anchorStatus: status };
      }),
    );
    res.status(201).json({ thread });
  });
  router.post("/threads/:threadId/replies", async (req, res) => {
    const input = bodySchema.parse(req.body);
    const actorId = res.locals.commentActorId as string;
    const projectId = String((req.params as Record<string, string>).projectId),
      fileId = String((req.params as Record<string, string>).fileId),
      threadId = String(req.params.threadId);
    const comment = await withProject(projectId, () =>
      prisma.$transaction(async (tx) => {
        await access(tx, actorId, projectId, fileId, writeRoles);
        if (
          !(await tx.commentThread.findFirst({
            where: { id: threadId, projectId, fileId },
          }))
        )
          throw new ApiError(404, "Discussion not found");
        if ((await tx.comment.count({ where: { threadId } })) >= 200)
          throw new ApiError(409, "Discussion has reached the reply limit");
        const created = await tx.comment.create({
          data: { threadId, authorId: actorId, body: input.body },
          include: commentInclude,
        });
        await tx.commentThread.update({
          where: { id: threadId },
          data: { updatedAt: new Date() },
        });
        return created;
      }),
    );
    res.status(201).json({ comment });
  });
  router.patch("/threads/:threadId", async (req, res) => {
    const input = z.object({ resolved: z.boolean() }).strict().parse(req.body);
    const actorId = res.locals.commentActorId as string;
    const projectId = String((req.params as Record<string, string>).projectId),
      fileId = String((req.params as Record<string, string>).fileId),
      threadId = String(req.params.threadId);
    const thread = await withProject(projectId, () =>
      prisma.$transaction(async (tx) => {
        const { file } = await access(
          tx,
          actorId,
          projectId,
          fileId,
          writeRoles,
        );
        if (
          !(await tx.commentThread.findFirst({
            where: { id: threadId, projectId, fileId },
          }))
        )
          throw new ApiError(404, "Discussion not found");
        const updated = await tx.commentThread.update({
          where: { id: threadId },
          data: {
            resolvedAt: input.resolved ? new Date() : null,
            resolvedById: input.resolved ? actorId : null,
          },
          include: threadInclude,
        });
        return { ...updated, anchorStatus: anchorStatus(file, updated.anchor) };
      }),
    );
    res.json({ thread });
  });
  for (const method of ["patch", "delete"] as const)
    router[method]("/comments/:commentId", async (req, res) => {
      const input = method === "patch" ? bodySchema.parse(req.body) : null;
      const actorId = res.locals.commentActorId as string;
      const projectId = String(
          (req.params as Record<string, string>).projectId,
        ),
        fileId = String((req.params as Record<string, string>).fileId),
        commentId = String(req.params.commentId);
      const comment = await withProject(projectId, () =>
        prisma.$transaction(async (tx) => {
          const { member } = await access(
            tx,
            actorId,
            projectId,
            fileId,
            writeRoles,
          );
          const current = await tx.comment.findFirst({
            where: { id: commentId, thread: { projectId, fileId } },
          });
          if (
            !current ||
            (current.authorId !== actorId && member.role !== "OWNER")
          )
            throw new ApiError(404, "Comment not found");
          const result =
            method === "delete"
              ? await tx.comment.delete({ where: { id: commentId } })
              : await tx.comment.update({
                  where: { id: commentId },
                  data: { body: input!.body },
                  include: commentInclude,
                });
          await tx.commentThread.update({
            where: { id: current.threadId },
            data: { updatedAt: new Date() },
          });
          return result;
        }),
      );
      if (method === "delete") {
        res.status(204).end();
        return;
      }
      res.json({ comment });
    });
  return router;
}
