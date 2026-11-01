import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { Prisma, type PrismaClient, type Role } from "@prisma/client";
import {
  createProjectSchema,
  updateProjectSchema,
  createFileSchema,
  updateFileSchema,
  initialFiles,
} from "@latex-free/shared";
import type { Config } from "./config.js";
import type { Auth } from "./auth.js";

export function createApp(prisma: PrismaClient, auth: Auth, config: Config) {
  const app = express();
  app.disable("x-powered-by");
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
  app.use(express.json({ limit: "2mb" }));
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/config", (_req, res) =>
    res.json({
      googleEnabled: Boolean(
        config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET,
      ),
    }),
  );
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
  const access = async (userId: string, projectId: string, roles: Role[]) => {
    const membership = await prisma.membership.findUnique({
      where: { userId_projectId: { userId, projectId } },
    });
    return membership && roles.includes(membership.role);
  };
  app.get("/api/projects", async (_req, res) => {
    const projects = await prisma.project.findMany({
      where: { members: { some: { userId: res.locals.userId } } },
      include: { files: { orderBy: { path: "asc" } } },
      orderBy: { updatedAt: "desc" },
    });
    res.json({ projects });
  });
  app.post("/api/projects", async (req, res) => {
    const input = createProjectSchema.parse(req.body);
    const project = await prisma.project.create({
      data: {
        ...input,
        members: { create: { userId: res.locals.userId, role: "OWNER" } },
        files: { create: initialFiles(input.template) },
      },
      include: { files: true },
    });
    res.status(201).json({ project });
  });
  app.patch("/api/projects/:projectId", async (req, res) => {
    if (
      !(await access(res.locals.userId, req.params.projectId, [
        "OWNER",
        "EDITOR",
      ]))
    ) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const data = updateProjectSchema.parse(req.body);
    res.json({
      project: await prisma.project.update({
        where: { id: req.params.projectId },
        data,
        include: { files: true },
      }),
    });
  });
  app.delete("/api/projects/:projectId", async (req, res) => {
    if (!(await access(res.locals.userId, req.params.projectId, ["OWNER"]))) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await prisma.project.delete({ where: { id: req.params.projectId } });
    res.status(204).end();
  });
  app.post("/api/projects/:projectId/files", async (req, res) => {
    if (
      !(await access(res.locals.userId, req.params.projectId, [
        "OWNER",
        "EDITOR",
      ]))
    ) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const input = createFileSchema.parse(req.body);
    const file = await prisma.$transaction(async (tx) => {
      const file = await tx.file.create({
        data: { ...input, projectId: req.params.projectId },
      });
      await tx.project.update({
        where: { id: req.params.projectId },
        data: { updatedAt: new Date() },
      });
      return file;
    });
    res.status(201).json({ file });
  });
  app.put("/api/projects/:projectId/files/:fileId", async (req, res) => {
    if (
      !(await access(res.locals.userId, req.params.projectId, [
        "OWNER",
        "EDITOR",
      ]))
    ) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const input = updateFileSchema.parse(req.body);
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.file.updateMany({
        where: {
          id: req.params.fileId,
          projectId: req.params.projectId,
          version: input.version,
        },
        data: { content: input.content, version: { increment: 1 } },
      });
      if (!updated.count) return null;
      await tx.project.update({
        where: { id: req.params.projectId },
        data: { updatedAt: new Date() },
      });
      return tx.file.findUniqueOrThrow({ where: { id: req.params.fileId } });
    });
    if (!result) {
      res
        .status(409)
        .json({
          error: "This file changed. Reload the workspace before saving again.",
        });
      return;
    }
    res.json({ file: result });
  });
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
    void _next;
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
