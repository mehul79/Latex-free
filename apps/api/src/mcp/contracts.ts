export const TOKEN_SCOPES = [
  "projects:read",
  "files:read",
  "files:write",
  "compile",
  "projects:share",
] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export interface AccessTokenRecord {
  id: string;
  userId: string;
  label: string;
  tokenHash: string;
  scopes: string[];
  projectIds: string[];
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}
export interface TokenStore {
  /** Must serialize creation per user and reject when active count reaches limit. */
  create(
    record: Omit<AccessTokenRecord, "id" | "createdAt">,
    activeLimit: number,
  ): Promise<AccessTokenRecord>;
  findByHash(hash: string): Promise<AccessTokenRecord | null>;
  list(userId: string): Promise<AccessTokenRecord[]>;
  revoke(userId: string, id: string): Promise<boolean>;
}
export interface TextFile {
  id: string;
  path: string;
  content: string;
  version: number;
  encoding?: string;
}
export type ProjectRole = "OWNER" | "EDITOR" | "VIEWER";
export interface CompileDiagnostics {
  runId: string;
  success: boolean;
  errors: unknown[];
  versions: Record<string, number>;
  stale?: boolean;
  currentVersions?: Record<string, number>;
}
/** Every method must authorize actorId against current membership, and all mutations
 * must run through the collaboration authority with transactional version checks.
 * Never return binary contents from these methods. */
export interface McpDomain {
  role(actorId: string, projectId: string): Promise<ProjectRole | null>;
  listProjects(
    actorId: string,
    projectIds: readonly string[],
  ): Promise<unknown>;
  listFiles(actorId: string, projectId: string): Promise<unknown>;
  readFile(
    actorId: string,
    projectId: string,
    fileId: string,
  ): Promise<TextFile>;
  createFile(
    actorId: string,
    projectId: string,
    input: { path: string; content: string },
  ): Promise<unknown>;
  writeFile(
    actorId: string,
    projectId: string,
    fileId: string,
    expectedVersion: number,
    content: string,
  ): Promise<unknown>;
  /** Exact literal replacement, version + expectedMatches checked atomically under project lock. */
  editFile(
    actorId: string,
    projectId: string,
    fileId: string,
    input: {
      expectedVersion: number;
      find: string;
      replace: string;
      expectedMatches: number;
    },
  ): Promise<unknown>;
  deleteFile(
    actorId: string,
    projectId: string,
    fileId: string,
    expectedVersion: number,
  ): Promise<unknown>;
  compile(
    actorId: string,
    projectId: string,
    input: { mainFile: string; engine: "pdflatex" | "xelatex" | "lualatex" },
  ): Promise<CompileDiagnostics>;
  getCompileErrors(
    actorId: string,
    projectId: string,
    runId: string,
  ): Promise<CompileDiagnostics>;
  shareProject(
    actorId: string,
    projectId: string,
    input: { email: string; role: "EDITOR" | "VIEWER" },
  ): Promise<unknown>;
}
