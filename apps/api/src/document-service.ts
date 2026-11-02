import { withProject } from "./project-mutex.js";
import {
  type File,
  type Prisma,
  type PrismaClient,
  type Role,
} from "@prisma/client";
import {
  fileByteLength,
  MAX_PROJECT_BYTES,
  updateFileSchema,
} from "@latex-free/shared";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public file?: File,
  ) {
    super(message);
  }
}
export async function authorizeProject(
  tx: Prisma.TransactionClient,
  projectId: string,
  actorId: string,
  roles: Role[],
) {
  await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
  const member = await tx.membership.findUnique({
    where: { userId_projectId: { userId: actorId, projectId } },
  });
  if (!member || !roles.includes(member.role))
    throw new ApiError(404, "Project not found");
  return member;
}
export async function snapshot(
  tx: Prisma.TransactionClient,
  file: File,
  authorId: string | null,
  reason: string,
) {
  if (file.encoding !== "utf8") return;
  await tx.fileRevision.create({
    data: {
      fileId: file.id,
      authorId,
      version: file.version,
      path: file.path,
      content: file.content,
      reason,
    },
  });
}
export async function baseline(tx: Prisma.TransactionClient, file: File) {
  if (file.encoding !== "utf8") return;
  if (
    !(await tx.fileRevision.findUnique({
      where: { fileId_version: { fileId: file.id, version: file.version } },
    }))
  )
    await snapshot(tx, file, null, "baseline");
}
export function checkVersion(file: File, expectedVersion: number) {
  if (file.version !== expectedVersion)
    throw new ApiError(
      409,
      "This file changed. Resolve your draft before trying again.",
      file,
    );
}
export interface DocumentAuthority {
  writeText(
    projectId: string,
    fileId: string,
    actorId: string,
    expectedVersion: number,
    content: string,
    reason: "edit" | "restore",
  ): Promise<File>;
}
export class DocumentService {
  private authority?: DocumentAuthority;
  attachCollaboration(authority: DocumentAuthority) {
    if (this.authority && this.authority !== authority)
      throw new Error("Document authority already attached");
    this.authority = authority;
  }

  constructor(private prisma: PrismaClient) {}
  async applyAiProposal(
    _actorId: string,
    _proposalId: string,
  ): Promise<{ status: "applied"; projectId: string; files: File[] }> {
    void _actorId;
    void _proposalId;
    throw new ApiError(503, "AI proposal application is not configured");
  }
  async writeText(
    projectId: string,
    fileId: string,
    actorId: string,
    expectedVersion: number,
    content: string,
    reason: "edit" | "restore",
  ) {
    if (this.authority)
      return this.authority.writeText(
        projectId,
        fileId,
        actorId,
        expectedVersion,
        content,
        reason,
      );
    updateFileSchema.parse({ version: expectedVersion, content });
    return withProject(projectId, () =>
      this.prisma.$transaction(async (tx) => {
        await authorizeProject(tx, projectId, actorId, ["OWNER", "EDITOR"]);
        const file = await tx.file.findFirst({
          where: { id: fileId, projectId },
        });
        if (!file) throw new ApiError(404, "File not found");
        checkVersion(file, expectedVersion);
        if (file.encoding !== "utf8")
          throw new ApiError(400, "Binary assets cannot be edited as text");
        const files = await tx.file.findMany({ where: { projectId } });
        if (
          files.reduce(
            (n, other) =>
              n +
              fileByteLength(
                other.id === file.id ? { ...other, content } : other,
              ),
            0,
          ) > MAX_PROJECT_BYTES
        )
          throw new ApiError(413, "Project exceeds size limit");
        await baseline(tx, file);
        const updated = await tx.file.update({
          where: { id: fileId },
          data: { content, version: { increment: 1 } },
        });
        await snapshot(tx, updated, actorId, reason);
        await tx.project.update({
          where: { id: projectId },
          data: { updatedAt: new Date() },
        });
        return updated;
      }),
    );
  }
}
