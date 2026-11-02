import type { Server as HttpServer } from "node:http";
import {
  Hocuspocus,
  IncomingMessage,
  type Connection,
  type Document,
} from "@hocuspocus/server";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import { fromNodeHeaders } from "better-auth/node";
import { type PrismaClient, type File, type Role } from "@prisma/client";
import {
  fileByteLength,
  MAX_PROJECT_BYTES,
  updateFileSchema,
} from "@latex-free/shared";
import type { Auth } from "./auth.js";
import type { Config } from "./config.js";
import {
  ApiError,
  authorizeProject,
  baseline,
  checkVersion,
  snapshot,
} from "./document-service.js";
import { acquireProject, withProject } from "./project-mutex.js";
import {
  cloneDocument,
  documentKey,
  equalBytes,
  MAX_Y_UPDATE_BYTES,
  parseDocumentKey,
  validateDocument,
} from "./collaboration-document.js";

type Context = {
  actorId: string;
  sessionId: string;
  headers: Headers;
  name: string;
  role: Role;
};
type MessageAdmission = {
  release: () => void;
  barrier?: number;
  failed: boolean;
  changed: boolean;
};
export class CollaborationService {
  readonly hocus: Hocuspocus<Context>;
  private versions = new WeakMap<Document, number>();
  private identities = new WeakSet<Connection>();
  private admissions = new WeakMap<Connection, MessageAdmission>();
  private timer: ReturnType<typeof setInterval>;
  private ws?: WebSocketServer;
  constructor(
    private prisma: PrismaClient,
    private auth: Auth,
    private config: Config,
  ) {
    this.hocus = new Hocuspocus<Context>({
      quiet: true,
      onAuthenticate: async ({
        documentName,
        requestHeaders,
        connectionConfig,
      }) => {
        const { projectId, fileId } = parseDocumentKey(documentName);
        const session = await this.auth.api.getSession({
          headers: requestHeaders,
        });
        if (!session) throw new ApiError(401, "Sign in to collaborate");
        return withProject(projectId, async () => {
          const member = await this.prisma.membership.findUnique({
            where: { userId_projectId: { userId: session.user.id, projectId } },
          });
          const file = await this.prisma.file.findFirst({
            where: { id: fileId, projectId, encoding: "utf8" },
          });
          if (!member || !file) throw new ApiError(404, "Document not found");
          connectionConfig.readOnly = member.role === "VIEWER";
          const loaded = this.hocus.documents.get(documentName);
          if (loaded) this.versions.set(loaded, file.version);
          return {
            actorId: session.user.id,
            sessionId: session.session.id,
            headers: requestHeaders,
            name: session.user.name,
            role: member.role,
          };
        });
      },
      onLoadDocument: async ({ document, documentName }) => {
        const { projectId, fileId } = parseDocumentKey(documentName);
        await withProject(projectId, () =>
          this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
            const file = await tx.file.findFirst({
              where: { id: fileId, projectId, encoding: "utf8" },
            });
            if (!file) throw new ApiError(404, "Document not found");
            document.getText("source");
            if (file.yState) Y.applyUpdate(document, file.yState);
            else {
              document.getText("source").insert(0, file.content);
              const { state } = validateDocument(document);
              await tx.file.update({
                where: { id: file.id },
                data: { yState: new Uint8Array(state) },
              });
            }
            const { content } = validateDocument(document);
            if (content !== file.content)
              throw new ApiError(500, "Collaborative document integrity error");
            this.versions.set(document, file.version);
          }),
        );
      },
      beforeHandleMessage: async ({
        documentName,
        connection,
        update,
        context,
        document,
      }) => {
        const { projectId } = parseDocumentKey(documentName);
        const admission: MessageAdmission = {
          release: await acquireProject(projectId),
          failed: false,
          changed: false,
        };
        this.admissions.set(connection, admission);
        try {
          if (update.byteLength > MAX_Y_UPDATE_BYTES)
            throw new ApiError(413, "Collaborative update exceeds size limit");
          await this.revalidate(documentName, context, connection);
          const message = new IncomingMessage(update);
          message.readVarString();
          if (message.readVarUint() === 5) {
            const body = JSON.parse(message.readVarString()) as {
              type?: string;
              sequence?: number;
            };
            if (
              body.type !== "persistence-barrier" ||
              !Number.isSafeInteger(body.sequence) ||
              body.sequence! < 0
            )
              throw new ApiError(400, "Invalid persistence barrier");
            admission.barrier = body.sequence;
          }
          if (!this.identities.has(connection)) {
            connection.sendStateless(
              JSON.stringify({
                type: "identity",
                user: { id: context.actorId, name: context.name },
                role: context.role,
                version: this.versions.get(document),
              }),
            );
            this.identities.add(connection);
          }
        } catch (error) {
          this.admissions.delete(connection);
          admission.release();
          throw this.reject(connection, error);
        }
      },
      beforeSync: async ({
        documentName,
        document,
        context,
        connection,
        type,
        payload,
      }) => {
        if (type !== 1 && type !== 2) return;
        const admission = this.admissions.get(connection)!;
        const candidate = cloneDocument(document);
        try {
          if (payload.byteLength > MAX_Y_UPDATE_BYTES)
            throw new ApiError(413, "Collaborative update exceeds size limit");
          Y.applyUpdate(candidate, payload);
          const next = validateDocument(candidate);
          const current = Y.encodeStateAsUpdate(document);
          if (equalBytes(current, next.state)) return;
          if (connection.readOnly)
            throw new ApiError(403, "This project is read only");
          const { projectId, fileId } = parseDocumentKey(documentName);
          const file = await this.persist(
            projectId,
            fileId,
            context.actorId,
            document,
            candidate,
            "collaboration",
            undefined,
            context.sessionId,
          );
          this.versions.set(document, file.version);
          admission.changed = true;
        } catch (error) {
          admission.failed = true;
          throw this.reject(connection, error);
        } finally {
          candidate.destroy();
        }
      },
      afterHandleMessage: async ({ connection, document }) => {
        const admission = this.admissions.get(connection);
        if (!admission) return;
        try {
          if (!admission.failed && admission.changed) this.status(document);
          if (!admission.failed && admission.barrier !== undefined)
            connection.sendStateless(
              JSON.stringify({
                type: "persisted",
                sequence: admission.barrier,
                version: this.versions.get(document),
              }),
            );
        } finally {
          this.admissions.delete(connection);
          admission.release();
        }
      },
      beforeHandleAwareness: async ({ states, transactionOrigin }) => {
        // Awareness is display-only; overwrite the claimed identity with the cookie user.
        const origin = transactionOrigin as {
          connection?: Connection<Context>;
        };
        const context = origin.connection?.context;
        if (context)
          for (const state of states.values()) {
            const colors = [
              "#2563eb",
              "#9333ea",
              "#dc2626",
              "#059669",
              "#d97706",
              "#db2777",
            ];
            const color =
              colors[
                [...context.actorId].reduce(
                  (sum, ch) => sum + ch.charCodeAt(0),
                  0,
                ) % colors.length
              ];
            state.user = {
              id: context.actorId,
              name: context.name,
              color,
              colorLight: `${color}33`,
            };
          }
      },
    });
    this.timer = setInterval(() => {
      void this.revalidateIdle();
    }, 15000);
    this.timer.unref();
  }
  private reject(connection: Connection, error: unknown) {
    const message =
      error instanceof ApiError
        ? error.message
        : "Changes could not be saved. Reconnect to retry.";
    connection.sendStateless(
      JSON.stringify({ type: "persistence-error", error: message }),
    );
    return Object.assign(new Error(message), {
      code:
        error instanceof ApiError && error.status < 500
          ? error.status === 401 || error.status === 403 || error.status === 404
            ? 4403
            : 4400
          : 1011,
      reason: message,
    });
  }
  private status(document: Document) {
    document.broadcastStateless(
      JSON.stringify({
        type: "document-status",
        version: this.versions.get(document),
      }),
    );
  }
  private async revalidate(
    key: string,
    context: Context,
    connection: Connection,
  ) {
    const { projectId, fileId } = parseDocumentKey(key);
    const session = await this.auth.api.getSession({
      headers: context.headers,
    });
    const member = await this.prisma.membership.findUnique({
      where: { userId_projectId: { userId: context.actorId, projectId } },
    });
    const file = await this.prisma.file.findFirst({
      where: { id: fileId, projectId, encoding: "utf8" },
      select: { id: true },
    });
    if (
      !session ||
      session.user.id !== context.actorId ||
      session.session.id !== context.sessionId ||
      !member ||
      !file
    )
      throw new ApiError(403, "Document access ended");
    if (context.role !== member.role)
      throw new ApiError(403, "Project role changed. Reload the project.");
    connection.readOnly = member.role === "VIEWER";
  }
  private async revalidateIdle() {
    for (const document of this.hocus.documents.values())
      for (const connection of document.connections.keys()) {
        try {
          await withProject(parseDocumentKey(document.name).projectId, () =>
            this.revalidate(document.name, connection.context, connection),
          );
        } catch {
          connection.close({ code: 4403, reason: "Document access ended" });
        }
      }
  }
  private async persist(
    projectId: string,
    fileId: string,
    actorId: string,
    current: Y.Doc,
    candidate: Y.Doc,
    reason: "edit" | "restore" | "collaboration",
    expectedVersion?: number,
    sessionId?: string,
  ) {
    const next = validateDocument(candidate);
    return this.prisma.$transaction(async (tx) => {
      await authorizeProject(tx, projectId, actorId, ["OWNER", "EDITOR"]);
      if (sessionId) {
        const session = await tx.session.findUnique({
          where: { id: sessionId },
        });
        if (
          !session ||
          session.userId !== actorId ||
          session.expiresAt.getTime() <= Date.now()
        )
          throw new ApiError(401, "Session expired");
      }
      const file = await tx.file.findFirst({
        where: { id: fileId, projectId },
      });
      if (!file || file.encoding !== "utf8")
        throw new ApiError(404, "Text file not found");
      if (expectedVersion !== undefined) checkVersion(file, expectedVersion);
      if (
        !file.yState ||
        !equalBytes(file.yState, Y.encodeStateAsUpdate(current)) ||
        current.getText("source").toString() !== file.content
      )
        throw new ApiError(500, "Collaborative document integrity error");
      const files = await tx.file.findMany({ where: { projectId } });
      if (
        files.reduce(
          (bytes, other) =>
            bytes +
            fileByteLength(
              other.id === fileId ? { ...other, content: next.content } : other,
            ),
          0,
        ) > MAX_PROJECT_BYTES
      )
        throw new ApiError(413, "Project exceeds size limit");
      await baseline(tx, file);
      const updated = await tx.file.update({
        where: { id: fileId },
        data: {
          content: next.content,
          yState: new Uint8Array(next.state),
          version: { increment: 1 },
        },
      });
      await snapshot(tx, updated, actorId, reason);
      await tx.project.update({
        where: { id: projectId },
        data: { updatedAt: new Date() },
      });
      return updated;
    });
  }
  async writeText(
    projectId: string,
    fileId: string,
    actorId: string,
    expectedVersion: number,
    content: string,
    reason: "edit" | "restore",
  ): Promise<File> {
    updateFileSchema.parse({ version: expectedVersion, content });
    // Loading may acquire the same project queue. Never load while holding it.
    const direct = await this.hocus.openDirectConnection(
      documentKey(projectId, fileId),
    );
    try {
      return await withProject(projectId, async () => {
        const document = direct.document!;
        const candidate = cloneDocument(document);
        try {
          const source = candidate.getText("source");
          candidate.transact(() => {
            source.delete(0, source.length);
            source.insert(0, content);
          });
          const file = await this.persist(
            projectId,
            fileId,
            actorId,
            document,
            candidate,
            reason,
            expectedVersion,
          );
          // Commit first. Only this application point can broadcast the durable state.
          Y.applyUpdate(document, Y.encodeStateAsUpdate(candidate));
          this.versions.set(document, file.version);
          this.status(document);
          return file;
        } finally {
          candidate.destroy();
        }
      });
    } finally {
      await direct.disconnect({ unloadImmediately: false });
    }
  }
  invalidate(
    projectId: string,
    reason: "membership" | "rename" | "deleted",
    fileId?: string,
    userId?: string,
  ) {
    for (const document of this.hocus.documents.values()) {
      const key = parseDocumentKey(document.name);
      if (key.projectId !== projectId || (fileId && key.fileId !== fileId))
        continue;
      for (const connection of document.connections.keys())
        if (!userId || connection.context.actorId === userId) {
          connection.sendStateless(
            JSON.stringify({ type: "reload-required", reason }),
          );
          connection.close({ code: 4403, reason: `Project ${reason}` });
        }
    }
  }
  attach(server: HttpServer) {
    const ws = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_Y_UPDATE_BYTES,
    });
    this.ws = ws;
    server.on("upgrade", (request, socket, head) => {
      if (
        new URL(request.url ?? "/", "http://localhost").pathname !==
          "/api/collaboration" ||
        request.headers.origin !== this.config.WEB_ORIGIN
      ) {
        socket.destroy();
        return;
      }
      ws.handleUpgrade(request, socket, head, (websocket) => {
        const headers = fromNodeHeaders(request.headers);
        const client = this.hocus.handleConnection(
          websocket,
          new Request(`http://localhost${request.url}`, { headers }),
        );
        websocket.on("message", (data) =>
          client.handleMessage(new Uint8Array(data as Buffer)),
        );
        websocket.on("close", (code, reason) =>
          client.handleClose({ code, reason: reason.toString() }),
        );
        websocket.on("error", () => client.handleClose());
      });
    });
  }
  async destroy() {
    clearInterval(this.timer);
    await Promise.all(
      [...this.hocus.documents.values()].flatMap((document) =>
        [...document.connections.keys()].map((connection) =>
          connection.waitForPendingMessages(),
        ),
      ),
    );
    this.hocus.closeConnections();
    this.hocus.flushPendingStores();
    for (const socket of this.ws?.clients ?? []) socket.terminate();
    await new Promise<void>((resolve) =>
      this.ws ? this.ws.close(() => resolve()) : resolve(),
    );
    for (const document of this.hocus.documents.values()) document.destroy();
    this.hocus.documents.clear();
    await this.hocus.hooks("onDestroy", { instance: this.hocus });
  }
}
