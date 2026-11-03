import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  createProjectSchema,
  updateProjectSchema,
  updateFileSchema,
  initialFiles,
  compileRequestSchema,
  compileResultSchema,
  importProjectSchema,
  renameFileSchema,
  deleteFileSchema,
  restoreTrashedFileSchema,
  pathsCollide,
  updateProjectMemberSchema,
  restoreFileRevisionSchema,
  revisionsQuerySchema,
} from "@latex-free/shared";
import {
  ApiError,
  DocumentService,
  authorizeProject,
  baseline,
  checkVersion,
  snapshot,
} from "./document-service.js";
import { ProjectService } from "./project-service.js";
import { withProject } from "./project-mutex.js";
import type { CollaborationService } from "./collaboration.js";
import { createCommentsRouter } from "./comments/router.js";
import { createMcpRouter } from "./mcp/server.js";
import { createTokenRouter } from "./mcp/tokens.js";
import { createPrismaTokenStore } from "./mcp/prisma-tokens.js";
import { McpCompileService } from "./mcp/compile-service.js";
import { createMcpDomain } from "./mcp/domain.js";
import type { Config } from "./config.js";
import type { Auth } from "./auth.js";

export function createApp(
  prisma: PrismaClient,
  auth: Auth,
  config: Config,
  collaboration?: CollaborationService,
) {
  const app = express();
  app.disable("x-powered-by");
  // Persisted CRDT bytes stay private; project/file API responses expose text.
  app.set("json replacer", (key: string, value: unknown) =>
    key === "yState" ? undefined : value,
  );
  const projectTransaction = <T>(
    projectId: string,
    action: (tx: Prisma.TransactionClient) => Promise<T>,
  ) => withProject(projectId, () => prisma.$transaction(action));
  app.use(helmet());
  app.use(cors({ origin: config.WEB_ORIGIN, credentials: true }));
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  // Better Auth must receive the raw request before express.json().
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(express.json({ limit: "30mb" }));
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/config", (_req, res) =>
    res.json({
      collaborationEnabled: Boolean(collaboration),
      compilerEnabled: Boolean(config.COMPILER_URL && config.COMPILER_TOKEN),
      localCompileEnabled:
        config.NODE_ENV !== "production" &&
        config.ENABLE_LOCAL_COMPILE &&
        Boolean(config.COMPILER_URL && config.COMPILER_TOKEN),
      googleEnabled: Boolean(
        config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET,
      ),
    }),
  );
  let activeCompiles = 0;
  const compileLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  app.post("/api/compile", compileLimiter, async (req, res) => {
    if (req.headers.origin !== config.WEB_ORIGIN) {
      res.status(403).json({ error: "Untrusted origin" });
      return;
    }
    const localEnabled =
      config.NODE_ENV !== "production" && config.ENABLE_LOCAL_COMPILE;
    if (
      !localEnabled &&
      !(await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }))
    ) {
      res.status(401).json({ error: "Sign in to compile" });
      return;
    }
    const input = compileRequestSchema.parse(req.body);
    if (!config.COMPILER_URL || !config.COMPILER_TOKEN) {
      res.status(503).json({ error: "Compiler is not configured" });
      return;
    }
    if (activeCompiles >= 2) {
      res.status(429).json({ error: "Compiler is busy. Try again shortly." });
      return;
    }
    activeCompiles++;
    try {
      const response = await fetch(new URL("/compile", config.COMPILER_URL), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.COMPILER_TOKEN}`,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) {
        res.status(response.status === 429 ? 429 : 503).json({
          error:
            response.status === 429
              ? "Compiler is busy. Try again shortly."
              : "Compiler is unavailable",
        });
        return;
      }
      const maxResponseBytes = 60 * 1024 * 1024;
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty compiler response");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxResponseBytes) {
          await reader.cancel();
          throw new Error("Compiler response too large");
        }
        chunks.push(value);
      }
      const result = compileResultSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      res.json(result);
    } catch {
      res
        .status(503)
        .json({ error: "Compiler is unavailable. Try again shortly." });
    } finally {
      activeCompiles--;
    }
  });
  // Cookie-authenticated writes must originate from our frontend. CORS alone is not CSRF protection.
  app.use("/api/projects", (req, res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== config.WEB_ORIGIN
    ) {
      res.status(403).json({ error: "Untrusted origin" });
      return;
    }
    next();
  });
  app.use("/api/projects", async (req, res, next) => {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) {
      res.status(401).json({ error: "Sign in to access projects" });
      return;
    }
    res.locals.userId = session.user.id;
    next();
  });
  const documents = new DocumentService(prisma);
  if (collaboration) documents.attachCollaboration(collaboration);
  const projectsDomain = new ProjectService(
    prisma,
    documents,
    collaboration?.invalidate.bind(collaboration),
  );
  const readAccess = async (
    userId: string,
    projectId: string,
    ownerOnly = false,
  ) => {
    const member = await prisma.membership.findUnique({
      where: { userId_projectId: { userId, projectId } },
    });
    if (!member || (ownerOnly && member.role !== "OWNER"))
      throw new ApiError(404, "Project not found");
  };
  app.get("/api/projects", async (_req, res) => {
    const projects = await prisma.project.findMany({
      where: { members: { some: { userId: res.locals.userId } } },
      include: {
        files: { where: { deletedAt: null }, orderBy: { path: "asc" } },
        members: {
          where: { userId: res.locals.userId },
          select: { role: true },
        },
      },
      orderBy: { updatedAt: "desc" },
    });
    res.json({
      projects: projects.map(({ members, ...project }) => ({
        ...project,
        role: members[0].role,
      })),
    });
  });
  for (const imported of [false, true]) {
    app.post(
      imported ? "/api/projects/import" : "/api/projects",
      async (req, res) => {
        const input = imported
          ? importProjectSchema.parse(req.body)
          : createProjectSchema.parse(req.body);
        const project = await prisma.$transaction(async (tx) => {
          const project = await tx.project.create({
            data: {
              name: input.name,
              template: "template" in input ? input.template : "blank",
              members: { create: { userId: res.locals.userId, role: "OWNER" } },
              files: {
                create:
                  "files" in input ? input.files : initialFiles(input.template),
              },
            },
            include: {
              files: { where: { deletedAt: null }, orderBy: { path: "asc" } },
            },
          });
          for (const file of project.files)
            await snapshot(tx, file, res.locals.userId, "create");
          return project;
        });
        res.status(201).json({ project: { ...project, role: "OWNER" } });
      },
    );
  }
  app.patch("/api/projects/:projectId", async (req, res) => {
    const data = updateProjectSchema.parse(req.body);
    const project = await projectTransaction(
      req.params.projectId,
      async (tx) => {
        const member = await authorizeProject(
          tx,
          req.params.projectId,
          res.locals.userId,
          ["OWNER", "EDITOR"],
        );
        return {
          ...(await tx.project.update({
            where: { id: req.params.projectId },
            data,
            include: { files: { where: { deletedAt: null } } },
          })),
          role: member.role,
        };
      },
    );
    res.json({ project });
  });
  app.delete("/api/projects/:projectId", async (req, res) => {
    await projectTransaction(req.params.projectId, async (tx) => {
      await authorizeProject(tx, req.params.projectId, res.locals.userId, [
        "OWNER",
      ]);
      await tx.project.delete({ where: { id: req.params.projectId } });
    });
    collaboration?.invalidate(req.params.projectId, "deleted");
    res.status(204).end();
  });
  const memberSelect = {
    role: true,
    user: { select: { id: true, name: true, email: true, image: true } },
  } as const;
  const memberJson = ({
    role,
    user,
  }: {
    role: string;
    user: { id: string; name: string; email: string; image: string | null };
  }) => ({
    userId: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    role,
  });
  const membersRoute = "/api/projects/:projectId/members";
  app.get(membersRoute, async (req, res) => {
    await readAccess(res.locals.userId, req.params.projectId, true);
    const members = await prisma.membership.findMany({
      where: { projectId: req.params.projectId },
      select: memberSelect,
      orderBy: { userId: "asc" },
    });
    res.json({ members: members.map(memberJson) });
  });
  app.post(membersRoute, async (req, res) => {
    const member = await projectsDomain.shareProject(
      res.locals.userId,
      req.params.projectId,
      req.body,
    );
    res.status(201).json({ member });
  });
  for (const method of ["patch", "delete"] as const)
    app[method](`${membersRoute}/:userId`, async (req, res) => {
      const input =
        method === "patch"
          ? updateProjectMemberSchema.parse(req.body)
          : undefined;
      const member = await projectTransaction(
        req.params.projectId,
        async (tx) => {
          await authorizeProject(tx, req.params.projectId, res.locals.userId, [
            "OWNER",
          ]);
          const where = {
            userId_projectId: {
              userId: req.params.userId,
              projectId: req.params.projectId,
            },
          };
          const target = await tx.membership.findUnique({ where });
          if (!target) throw new ApiError(404, "Member not found");
          if (target.role === "OWNER")
            throw new ApiError(
              400,
              "The project owner cannot be changed or removed",
            );
          if (method === "delete") {
            await tx.membership.delete({ where });
            return null;
          }
          return tx.membership.update({
            where,
            data: { role: input!.role },
            select: memberSelect,
          });
        },
      );
      collaboration?.invalidate(
        req.params.projectId,
        "membership",
        undefined,
        req.params.userId,
      );
      if (!member) {
        res.status(204).end();
        return;
      }
      res.json({ member: memberJson(member) });
    });
  app.post("/api/projects/:projectId/files", async (req, res) => {
    const file = await projectsDomain.createFile(
      res.locals.userId,
      req.params.projectId,
      req.body,
    );
    res.status(201).json({ file });
  });
  app.get("/api/projects/:projectId/trash", async (req, res) => {
    const files = await projectsDomain.listTrash(
      res.locals.userId,
      req.params.projectId,
    );
    res.json({ files });
  });
  app.post(
    "/api/projects/:projectId/trash/:fileId/restore",
    async (req, res) => {
      const input = restoreTrashedFileSchema.parse(req.body);
      const file = await projectsDomain.restoreTrashedFile(
        res.locals.userId,
        req.params.projectId,
        req.params.fileId,
        input,
      );
      res.json({ file });
    },
  );
  app.delete("/api/projects/:projectId/trash/:fileId", async (req, res) => {
    const input = deleteFileSchema.parse(req.query);
    await projectsDomain.purgeTrashedFile(
      res.locals.userId,
      req.params.projectId,
      req.params.fileId,
      input.version,
    );
    res.status(204).end();
  });
  const fileRoute = "/api/projects/:projectId/files/:fileId";
  app.put(fileRoute, async (req, res) => {
    const input = updateFileSchema.parse(req.body);
    const file = await documents.writeText(
      req.params.projectId,
      req.params.fileId,
      res.locals.userId,
      input.version,
      input.content,
      "edit",
    );
    res.json({ file });
  });
  app.delete(fileRoute, async (req, res) => {
    const input = deleteFileSchema.parse(req.query);
    await projectsDomain.deleteFile(
      res.locals.userId,
      req.params.projectId,
      req.params.fileId,
      input.version,
    );
    res.status(204).end();
  });
  app.patch(fileRoute, async (req, res) => {
    const input = renameFileSchema.parse(req.body);
    const file = await projectTransaction(req.params.projectId, async (tx) => {
      await authorizeProject(tx, req.params.projectId, res.locals.userId, [
        "OWNER",
        "EDITOR",
      ]);
      const file = await tx.file.findFirst({
        where: {
          id: req.params.fileId,
          projectId: req.params.projectId,
          deletedAt: null,
        },
      });
      if (!file) throw new ApiError(404, "File not found");
      checkVersion(file, input.version);
      const files = await tx.file.findMany({
        where: { projectId: req.params.projectId, deletedAt: null },
      });
      if (
        files.some(
          (other) =>
            other.id !== file.id && pathsCollide(other.path, input.path),
        )
      )
        throw new ApiError(409, "File paths collide");
      await baseline(tx, file);
      const updated = await tx.file.update({
        where: { id: file.id },
        data: { path: input.path, version: { increment: 1 } },
      });
      await snapshot(tx, updated, res.locals.userId, "rename");
      await tx.project.update({
        where: { id: req.params.projectId },
        data: { updatedAt: new Date() },
      });
      return updated;
    });
    collaboration?.invalidate(
      req.params.projectId,
      "rename",
      req.params.fileId,
    );
    res.json({ file });
  });
  const revisionSelect = {
    id: true,
    version: true,
    path: true,
    createdAt: true,
    reason: true,
    author: { select: { id: true, name: true } },
  } as const;
  const revisionsRoute = `${fileRoute}/revisions`;
  const readableFile = async (
    projectId: string,
    fileId: string,
    actorId: string,
  ) => {
    await readAccess(actorId, projectId);
    const file = await prisma.file.findFirst({
      where: { id: fileId, projectId, deletedAt: null },
    });
    if (!file || file.encoding !== "utf8")
      throw new ApiError(404, "Text file not found");
    return file;
  };
  app.get(revisionsRoute, async (req, res) => {
    const input = revisionsQuerySchema.parse(req.query);
    await readableFile(
      req.params.projectId,
      req.params.fileId,
      res.locals.userId,
    );
    // Lazy baselines are serialized with writers and never overwrite an existing snapshot.
    await projectTransaction(req.params.projectId, async (tx) => {
      await authorizeProject(tx, req.params.projectId, res.locals.userId, [
        "OWNER",
        "EDITOR",
        "VIEWER",
      ]);
      const file = await tx.file.findFirst({
        where: {
          id: req.params.fileId,
          projectId: req.params.projectId,
          deletedAt: null,
        },
      });
      if (!file || file.encoding !== "utf8")
        throw new ApiError(404, "Text file not found");
      await baseline(tx, file);
    });
    const cursor = input.cursor
      ? await prisma.fileRevision.findFirst({
          where: { id: input.cursor, fileId: req.params.fileId },
        })
      : null;
    if (input.cursor && !cursor)
      throw new ApiError(400, "Invalid revision cursor");
    const revisions = await prisma.fileRevision.findMany({
      where: {
        fileId: req.params.fileId,
        ...(cursor ? { version: { lt: cursor.version } } : {}),
      },
      select: revisionSelect,
      orderBy: { version: "desc" },
      take: input.limit + 1,
    });
    const more = revisions.length > input.limit;
    if (more) revisions.pop();
    res.json({
      revisions,
      nextCursor: more ? revisions[revisions.length - 1].id : null,
    });
  });
  app.get(`${revisionsRoute}/:revisionId`, async (req, res) => {
    await readableFile(
      req.params.projectId,
      req.params.fileId,
      res.locals.userId,
    );
    const revision = await prisma.fileRevision.findFirst({
      where: { id: req.params.revisionId, fileId: req.params.fileId },
      select: { ...revisionSelect, content: true },
    });
    if (!revision) throw new ApiError(404, "Revision not found");
    res.json({ revision });
  });
  app.post(`${revisionsRoute}/:revisionId/restore`, async (req, res) => {
    const input = restoreFileRevisionSchema.parse(req.body);
    await readableFile(
      req.params.projectId,
      req.params.fileId,
      res.locals.userId,
    );
    const revision = await prisma.fileRevision.findFirst({
      where: { id: req.params.revisionId, fileId: req.params.fileId },
    });
    if (!revision) throw new ApiError(404, "Revision not found");
    const file = await documents.writeText(
      req.params.projectId,
      req.params.fileId,
      res.locals.userId,
      input.expectedVersion,
      revision.content,
      "restore",
    );
    res.json({ file });
  });
  app.use(
    "/api/projects/:projectId/files/:fileId/discussions",
    createCommentsRouter({
      prisma,
      trustedOrigin: config.WEB_ORIGIN,
      getSessionUserId: async (req) =>
        (await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }))
          ?.user.id ?? null,
    }),
  );
  const tokens = createPrismaTokenStore(prisma);
  const domain = createMcpDomain(
    projectsDomain,
    new McpCompileService(projectsDomain, config),
  );
  app.use(
    "/mcp",
    createMcpRouter({ tokens, domain, trustedOrigin: config.WEB_ORIGIN }),
  );
  app.use(
    "/api/tokens",
    createTokenRouter({
      tokens,
      trustedOrigin: config.WEB_ORIGIN,
      getSessionUserId: async (req) =>
        (await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }))
          ?.user.id ?? null,
      canAccessProject: async (userId, projectId) =>
        Boolean(await projectsDomain.role(userId, projectId)),
    }),
  );
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
    void _next;
    if (error instanceof ApiError) {
      res.status(error.status).json({
        error: error.message,
        ...(error.file ? { file: error.file } : {}),
      });
      return;
    }
    if (error?.name === "ZodError") {
      res.status(400).json({ error: "Invalid request", details: error.issues });
      return;
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      res.status(409).json({ error: "That name already exists" });
      return;
    }
    if (error?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }
    if (error?.type === "entity.too.large") {
      res.status(413).json({ error: "Request too large" });
      return;
    }
    console.error(
      "API request failed",
      error instanceof Error ? error.message : "Unknown error",
    );
    res.status(500).json({ error: "Something went wrong. Please try again." });
  };
  app.use(handleError);
  return app;
}
