import type { PrismaClient } from "@prisma/client";
import {
  createFileSchema,
  addProjectMemberSchema,
  pathsCollide,
  fileByteLength,
  MAX_PROJECT_FILES,
  MAX_PROJECT_BYTES,
  restoreTrashedFileSchema,
} from "@latex-free/shared";
import {
  ApiError,
  DocumentService,
  authorizeProject,
  checkVersion,
  snapshot,
  baseline,
} from "./document-service.js";
import { withProject } from "./project-mutex.js";

const readers = ["OWNER", "EDITOR", "VIEWER"] as const;
export class ProjectService {
  constructor(
    private prisma: PrismaClient,
    private documents: DocumentService,
    private invalidate?: (
      projectId: string,
      reason: "membership" | "rename" | "deleted",
      fileId?: string,
      userId?: string,
    ) => void,
  ) {}
  applyAiProposal(actorId: string, proposalId: string) {
    return this.documents.applyAiProposal(actorId, proposalId);
  }
  async role(actorId: string, projectId: string) {
    return (
      (
        await this.prisma.membership.findUnique({
          where: { userId_projectId: { userId: actorId, projectId } },
        })
      )?.role ?? null
    );
  }
  async listProjects(actorId: string, projectIds: readonly string[]) {
    const projects = await this.prisma.project.findMany({
      where: {
        id: { in: [...projectIds] },
        members: { some: { userId: actorId } },
      },
      select: {
        id: true,
        name: true,
        updatedAt: true,
        members: { where: { userId: actorId }, select: { role: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    return projects.map(({ members, ...p }) => ({
      ...p,
      role: members[0].role,
    }));
  }
  async listFiles(actorId: string, projectId: string) {
    return withProject(projectId, () =>
      this.prisma.$transaction(async (tx) => {
        await authorizeProject(tx, projectId, actorId, [...readers]);
        return tx.file.findMany({
          where: { projectId, deletedAt: null },
          select: {
            id: true,
            path: true,
            version: true,
            encoding: true,
            mimeType: true,
          },
          orderBy: { path: "asc" },
        });
      }),
    );
  }
  async readFile(actorId: string, projectId: string, fileId: string) {
    return withProject(projectId, () =>
      this.prisma.$transaction(async (tx) => {
        await authorizeProject(tx, projectId, actorId, [...readers]);
        const file = await tx.file.findFirst({
          where: { id: fileId, projectId, deletedAt: null },
        });
        if (!file || file.encoding !== "utf8")
          throw new ApiError(404, "Text file not found");
        return file;
      }),
    );
  }
  async createFile(actorId: string, projectId: string, raw: unknown) {
    const input = createFileSchema.parse(raw);
    return withProject(projectId, () =>
      this.prisma.$transaction(async (tx) => {
        await authorizeProject(tx, projectId, actorId, ["OWNER", "EDITOR"]);
        const files = await tx.file.findMany({ where: { projectId } });
        if (
          files.some(
            (file) => !file.deletedAt && pathsCollide(file.path, input.path),
          )
        )
          throw new ApiError(409, "File paths collide");
        if (
          files.length >= MAX_PROJECT_FILES ||
          files.reduce(
            (n, file) => n + fileByteLength(file),
            fileByteLength(input),
          ) > MAX_PROJECT_BYTES
        )
          throw new ApiError(413, "Project exceeds size limit");
        const file = await tx.file.create({ data: { ...input, projectId } });
        await snapshot(tx, file, actorId, "create");
        await tx.project.update({
          where: { id: projectId },
          data: { updatedAt: new Date() },
        });
        return file;
      }),
    );
  }
  writeFile(
    actorId: string,
    projectId: string,
    fileId: string,
    expectedVersion: number,
    content: string,
  ) {
    return this.documents.writeText(
      projectId,
      fileId,
      actorId,
      expectedVersion,
      content,
      "edit",
    );
  }
  async editFile(
    actorId: string,
    projectId: string,
    fileId: string,
    input: {
      expectedVersion: number;
      find: string;
      replace: string;
      expectedMatches: number;
    },
  ) {
    const file = await this.readFile(actorId, projectId, fileId);
    checkVersion(file, input.expectedVersion);
    if (
      !input.find ||
      !Number.isInteger(input.expectedMatches) ||
      input.expectedMatches < 1
    )
      throw new ApiError(400, "Invalid exact replacement");
    const parts = file.content.split(input.find);
    if (parts.length - 1 !== input.expectedMatches)
      throw new ApiError(409, "Exact match count changed");
    // The collaboration authority compares this version again under its lock. A
    // concurrent edit causes 409 instead of applying a replacement to stale text.
    return this.writeFile(
      actorId,
      projectId,
      fileId,
      input.expectedVersion,
      parts.join(input.replace),
    );
  }
  async deleteFile(
    actorId: string,
    projectId: string,
    fileId: string,
    expectedVersion: number,
  ) {
    await withProject(projectId, async () => {
      await this.prisma.$transaction(async (tx) => {
        await authorizeProject(tx, projectId, actorId, ["OWNER", "EDITOR"]);
        const file = await tx.file.findFirst({
          where: { id: fileId, projectId, deletedAt: null },
        });
        if (!file) throw new ApiError(404, "File not found");
        checkVersion(file, expectedVersion);
        await baseline(tx, file);
        const trashed = await tx.file.update({
          where: { id: fileId },
          data: { deletedAt: new Date(), version: { increment: 1 } },
        });
        await snapshot(tx, trashed, actorId, "trash");
        await tx.project.update({
          where: { id: projectId },
          data: { updatedAt: new Date() },
        });
      });
      // Close stale sockets after commit while the shared project queue is still held.
      this.invalidate?.(projectId, "deleted", fileId);
    });
    return { deleted: true };
  }
  async listTrash(actorId: string, projectId: string) {
    return withProject(projectId, () =>
      this.prisma.$transaction(async (tx) => {
        await authorizeProject(tx, projectId, actorId, ["OWNER", "EDITOR"]);
        return tx.file.findMany({
          where: { projectId, deletedAt: { not: null } },
          select: {
            id: true,
            path: true,
            version: true,
            deletedAt: true,
            encoding: true,
            mimeType: true,
          },
          orderBy: [{ deletedAt: "desc" }, { id: "asc" }],
          take: MAX_PROJECT_FILES,
        });
      }),
    );
  }
  async restoreTrashedFile(
    actorId: string,
    projectId: string,
    fileId: string,
    raw: unknown,
  ) {
    const input = restoreTrashedFileSchema.parse(raw);
    return withProject(projectId, () =>
      this.prisma.$transaction(async (tx) => {
        await authorizeProject(tx, projectId, actorId, ["OWNER", "EDITOR"]);
        const file = await tx.file.findFirst({
          where: { id: fileId, projectId, deletedAt: { not: null } },
        });
        if (!file) throw new ApiError(404, "Trashed file not found");
        checkVersion(file, input.version);
        const path = input.path ?? file.path;
        const active = await tx.file.findMany({
          where: { projectId, deletedAt: null },
          select: { path: true },
        });
        if (active.some((other) => pathsCollide(other.path, path)))
          throw new ApiError(
            409,
            "Restore path collides with an active file. Choose another path.",
          );
        await baseline(tx, file);
        const restored = await tx.file.update({
          where: { id: fileId },
          data: { path, deletedAt: null, version: { increment: 1 } },
        });
        await snapshot(tx, restored, actorId, "trash-restore");
        await tx.project.update({
          where: { id: projectId },
          data: { updatedAt: new Date() },
        });
        return restored;
      }),
    );
  }
  async purgeTrashedFile(
    actorId: string,
    projectId: string,
    fileId: string,
    expectedVersion: number,
  ) {
    await withProject(projectId, () =>
      this.prisma.$transaction(async (tx) => {
        await authorizeProject(tx, projectId, actorId, ["OWNER"]);
        const file = await tx.file.findFirst({
          where: { id: fileId, projectId, deletedAt: { not: null } },
        });
        if (!file) throw new ApiError(404, "Trashed file not found");
        checkVersion(file, expectedVersion);
        await tx.file.delete({ where: { id: fileId } });
        await tx.project.update({
          where: { id: projectId },
          data: { updatedAt: new Date() },
        });
      }),
    );
  }
  async shareProject(actorId: string, projectId: string, raw: unknown) {
    const input = addProjectMemberSchema.parse(raw);
    return withProject(projectId, () =>
      this.prisma.$transaction(async (tx) => {
        await authorizeProject(tx, projectId, actorId, ["OWNER"]);
        const user = await tx.user.findFirst({
          where: {
            email: { equals: input.email, mode: "insensitive" },
            accounts: { some: { providerId: "google" } },
          },
        });
        if (!user)
          throw new ApiError(
            404,
            "No account found. Ask this person to sign in with Google once first.",
          );
        if (
          await tx.membership.findUnique({
            where: { userId_projectId: { userId: user.id, projectId } },
          })
        )
          throw new ApiError(409, "This person already belongs to the project");
        const member = await tx.membership.create({
          data: { projectId, userId: user.id, role: input.role },
          select: {
            role: true,
            user: {
              select: { id: true, name: true, email: true, image: true },
            },
          },
        });
        return {
          userId: member.user.id,
          name: member.user.name,
          email: member.user.email,
          image: member.user.image,
          role: member.role,
        };
      }),
    );
  }
  /** Immutable committed server snapshot, serialized with every document writer. */
  async compileSnapshot(actorId: string, projectId: string) {
    return withProject(projectId, () =>
      this.prisma.$transaction(async (tx) => {
        await authorizeProject(tx, projectId, actorId, [...readers]);
        const files = await tx.file.findMany({
          where: { projectId, deletedAt: null },
          orderBy: { path: "asc" },
        });
        return {
          files: files.map(({ path, content, encoding, mimeType }) => ({
            path,
            content,
            encoding: encoding as "utf8" | "base64",
            ...(mimeType ? { mimeType } : {}),
          })),
          versions: Object.fromEntries(files.map((f) => [f.id, f.version])),
        };
      }),
    );
  }
}
