import type { Request } from "express";
import type { CitationCandidate } from "../research/index.js";
import type { ResumeAnalysis } from "../resume/index.js";
export interface AiTextFile {
  id: string;
  path: string;
  version: number;
  content: string;
  encoding?: string;
}
export interface AiChange {
  fileId: string;
  path: string;
  baseVersion: number;
  before: string;
  after: string;
}
export interface AiProposalPayload {
  domain: "resume" | "research";
  instruction: string;
  summary: string;
  changes: AiChange[];
  citations: CitationCandidate[];
  resumeReview?: ResumeAnalysis;
}
export interface AiProposalRecord {
  id: string;
  actorId: string;
  projectId: string;
  status: "pending" | "applied" | "rejected";
  payload: AiProposalPayload;
  createdAt: Date;
  expiresAt: Date;
  appliedAt: Date | null;
}
export interface AiProposalStore {
  create(proposal: AiProposalRecord): Promise<void>;
  get(id: string): Promise<AiProposalRecord | null>;
  /** Compare/update must be atomic. Accept is handled entirely by the domain transaction. */
  reject(id: string): Promise<boolean>;
}
export interface AiDomain {
  role(
    actorId: string,
    projectId: string,
  ): Promise<"OWNER" | "EDITOR" | "VIEWER" | null>;
  readFile(
    actorId: string,
    projectId: string,
    fileId: string,
  ): Promise<AiTextFile>;
  /** Reauthorize creator, expiry and every baseVersion; write files and status together.
   * Already applied is idempotent; any conflict leaves every file and status untouched. */
  applyProposalAtomic(
    actorId: string,
    projectId: string,
    proposalId: string,
  ): Promise<unknown>;
}
export interface AiProviderInput {
  domain: "resume" | "research";
  instruction: string;
  jobDescription?: string;
  files: AiTextFile[];
  citations: CitationCandidate[];
}
export interface AiProvider {
  generate(input: AiProviderInput, signal: AbortSignal): Promise<unknown>;
}
export interface AiRouterAuth {
  authenticate(request: Request): Promise<string | null>;
  trustedOrigin: string;
}
