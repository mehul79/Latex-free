import { randomUUID } from "node:crypto";
import { z } from "zod";
import { searchCitations, type CitationCandidate } from "../research/index.js";
import { analyzeResume } from "../resume/index.js";
import type {
  AiDomain,
  AiProposalRecord,
  AiProposalStore,
  AiProvider,
  AiTextFile,
  AiChange,
} from "./contracts.js";
export class AiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}
export const createProposalSchema = z
  .object({
    domain: z.enum(["resume", "research"]),
    instruction: z.string().trim().min(1).max(4000),
    fileIds: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(10)
      .refine((ids) => new Set(ids).size === ids.length),
    jobDescription: z.string().max(20000).optional(),
    citationQuery: z.string().trim().min(1).max(500).optional(),
    citationProvider: z
      .enum(["crossref", "arxiv", "semantic-scholar"])
      .optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.domain === "research" ||
      (!data.citationQuery && !data.citationProvider),
    "Citation search is available for research proposals only",
  );
const providerOutput = z
  .object({
    summary: z.string().trim().min(1).max(4000),
    edits: z
      .array(
        z
          .object({
            fileId: z.string().min(1),
            content: z.string().max(128 * 1024),
          })
          .strict(),
      )
      .max(10),
    citationKeys: z.array(z.string().regex(/^ref_[a-f0-9]{16}$/)).max(5),
  })
  .strict();
function citeKeys(source: string): string[] {
  return [
    ...source.matchAll(
      /\\(?:cite[a-zA-Z]*|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^{}]+)\}/g,
    ),
  ].flatMap((match) => match[1].split(",").map((key) => key.trim()));
}
const bytes = (value: unknown) => {
  try {
    const serialized =
      typeof value === "string" ? value : JSON.stringify(value);
    if (serialized === undefined) return Infinity;
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    return Infinity;
  }
};
function bibliographyMarkup(source: string): string {
  const matches = source.match(
    /\\begin\s*\{thebibliography\}[\s\S]*?\\end\s*\{thebibliography\}|\\begin\s*\{filecontents\*?\}[\s\S]*?\\end\s*\{filecontents\*?\}|@\w+\s*\{[^\n]*|\\bibitem\b[^\n]*/g,
  );
  return JSON.stringify(matches ?? []);
}
export interface AiServiceOptions {
  domain: AiDomain;
  store: AiProposalStore;
  provider?: AiProvider;
  citationSearch?: typeof searchCitations;
  now?: () => Date;
  timeoutMs?: number;
}
export class AiProposalService {
  private active = new Set<string>();
  private rates = new Map<string, number[]>();
  readonly enabled: boolean;
  constructor(private options: AiServiceOptions) {
    this.enabled = Boolean(options.provider);
  }
  private now() {
    return (this.options.now ?? (() => new Date()))();
  }
  private async authorize(actorId: string, projectId: string) {
    const role = await this.options.domain.role(actorId, projectId);
    if (role !== "OWNER" && role !== "EDITOR")
      throw new AiError(403, "Project editor access is required");
  }
  private async visible(actorId: string, projectId: string, id: string) {
    await this.authorize(actorId, projectId);
    const proposal = await this.options.store.get(id);
    if (
      !proposal ||
      proposal.actorId !== actorId ||
      proposal.projectId !== projectId
    )
      throw new AiError(404, "Proposal not found");
    return proposal;
  }
  async get(actorId: string, projectId: string, id: string) {
    return this.visible(actorId, projectId, id);
  }
  async create(
    actorId: string,
    projectId: string,
    raw: unknown,
  ): Promise<AiProposalRecord> {
    await this.authorize(actorId, projectId);
    if (!this.options.provider)
      throw new AiError(
        503,
        "AI is not configured. Set ANTHROPIC_API_KEY and ANTHROPIC_MODEL on the server.",
      );
    const parsed = createProposalSchema.safeParse(raw);
    if (!parsed.success) throw new AiError(400, "Invalid AI proposal request");
    const input = parsed.data;
    if (this.active.has(actorId))
      throw new AiError(
        429,
        "An AI proposal is already being generated for this user",
      );
    const now = this.now().getTime();
    const recent = (this.rates.get(actorId) ?? []).filter(
      (time) => now - time < 60000,
    );
    if (recent.length >= 3)
      throw new AiError(
        429,
        "AI proposal rate limit reached. Try again later.",
      );
    if (this.rates.size > 10000)
      for (const [key, entries] of this.rates)
        if (!entries.some((time) => now - time < 60000)) this.rates.delete(key);
    recent.push(now);
    this.rates.set(actorId, recent);
    this.active.add(actorId);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = async () => {
      const files: AiTextFile[] = [];
      for (const fileId of input.fileIds) {
        const file = await this.options.domain.readFile(
          actorId,
          projectId,
          fileId,
        );
        if (file.encoding && file.encoding !== "utf8")
          throw new AiError(
            400,
            "Only text files can be used for AI proposals",
          );
        files.push({
          id: file.id,
          path: file.path,
          version: file.version,
          content: file.content,
          encoding: file.encoding,
        });
      }
      if (bytes(files) + bytes(input) > 128 * 1024)
        throw new AiError(413, "Selected AI context exceeds 128 KiB");
      let citations: CitationCandidate[] = [];
      if (input.citationQuery)
        citations = await (this.options.citationSearch ?? searchCitations)({
          query: input.citationQuery,
          provider: input.citationProvider ?? "crossref",
          limit: 5,
        });
      if (controller.signal.aborted)
        throw new AiError(504, "AI proposal generation timed out");
      let output: unknown;
      try {
        output = await this.options.provider!.generate(
          {
            domain: input.domain,
            instruction: input.instruction,
            jobDescription: input.jobDescription,
            files,
            citations,
          },
          controller.signal,
        );
      } catch {
        if (controller.signal.aborted)
          throw new AiError(504, "AI proposal generation timed out");
        throw new AiError(502, "AI provider could not produce a proposal");
      }
      if (controller.signal.aborted)
        throw new AiError(504, "AI proposal generation timed out");
      if (bytes(output) > 256 * 1024)
        throw new AiError(502, "AI provider output exceeded the size limit");
      const validated = providerOutput.safeParse(output);
      if (!validated.success)
        throw new AiError(502, "AI provider returned an invalid proposal");
      const result = validated.data;
      if (
        new Set(result.edits.map((edit) => edit.fileId)).size !==
          result.edits.length ||
        new Set(result.citationKeys).size !== result.citationKeys.length
      )
        throw new AiError(
          502,
          "AI provider returned duplicate edits or citation keys",
        );
      const selectedKeys = new Set(result.citationKeys);
      if (
        result.citationKeys.some(
          (key) => !citations.some((citation) => citation.bibtexKey === key),
        )
      )
        throw new AiError(502, "AI provider referenced an unverified citation");
      const permittedKeys = new Set([
        ...files.flatMap((file) => citeKeys(file.content)),
        ...files.flatMap((file) =>
          [...file.content.matchAll(/@\w+\s*\{\s*([^,\s]+)/g)].map(
            (match) => match[1],
          ),
        ),
        ...selectedKeys,
      ]);
      const changes: AiChange[] = [];
      for (const edit of result.edits) {
        const original = files.find((file) => file.id === edit.fileId);
        if (!original)
          throw new AiError(
            502,
            "AI provider edited a file outside the selected context",
          );
        if (/\.bib$/i.test(original.path) && edit.content !== original.content)
          throw new AiError(
            502,
            "Bibliography metadata must come from verified citation providers",
          );
        if (citeKeys(edit.content).some((key) => !permittedKeys.has(key)))
          throw new AiError(
            502,
            "AI provider referenced an unverified citation",
          );
        if (
          bibliographyMarkup(edit.content) !==
          bibliographyMarkup(original.content)
        )
          throw new AiError(
            502,
            "AI provider cannot create or alter unverified bibliography metadata",
          );
        if (edit.content !== original.content)
          changes.push({
            fileId: original.id,
            path: original.path,
            baseVersion: original.version,
            before: original.content,
            after: edit.content,
          });
      }
      const usedCitations = citations.filter((citation) =>
        selectedKeys.has(citation.bibtexKey),
      );
      if (usedCitations.length) {
        const bibliography = files.find((file) => /\.bib$/i.test(file.path));
        if (!bibliography)
          throw new AiError(
            400,
            "Select a .bib file to insert verified citations",
          );
        const existingKeys = new Set(
          [...bibliography.content.matchAll(/@\w+\s*\{\s*([^,\s]+)/g)].map(
            (match) => match[1],
          ),
        );
        const additions = usedCitations.filter(
          (citation) => !existingKeys.has(citation.bibtexKey),
        );
        if (additions.length)
          changes.push({
            fileId: bibliography.id,
            path: bibliography.path,
            baseVersion: bibliography.version,
            before: bibliography.content,
            after:
              bibliography.content +
              "\n" +
              additions.map((citation) => citation.bibtex).join("\n\n") +
              "\n",
          });
      }
      if (!changes.length)
        throw new AiError(422, "AI provider proposed no file changes");
      if (bytes(changes) > 512 * 1024)
        throw new AiError(502, "AI proposal exceeded the size limit");
      // Membership can change during a slow provider call. Recheck before storing source text.
      await this.authorize(actorId, projectId);
      if (controller.signal.aborted)
        throw new AiError(504, "AI proposal generation timed out");
      const createdAt = this.now();
      const proposal: AiProposalRecord = {
        id: randomUUID(),
        actorId,
        projectId,
        status: "pending",
        payload: {
          domain: input.domain,
          instruction: input.instruction,
          summary: result.summary,
          changes,
          citations: usedCitations,
          ...(input.domain === "resume"
            ? {
                resumeReview: analyzeResume(
                  files
                    .filter((file) => !/\.bib$/i.test(file.path))
                    .map((file) => file.content)
                    .join("\n"),
                ),
              }
            : {}),
        },
        createdAt,
        expiresAt: new Date(createdAt.getTime() + 30 * 60000),
        appliedAt: null,
      };
      await this.options.store.create(proposal);
      return proposal;
    };
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new AiError(504, "AI proposal generation timed out"));
          }, this.options.timeoutMs ?? 45000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      this.active.delete(actorId);
    }
  }
  async accept(actorId: string, projectId: string, id: string) {
    const proposal = await this.visible(actorId, projectId, id);
    if (proposal.status === "applied") return proposal;
    if (proposal.status !== "pending")
      throw new AiError(409, "Proposal has already been rejected");
    if (proposal.expiresAt.getTime() <= this.now().getTime())
      throw new AiError(410, "Proposal has expired");
    await this.options.domain.applyProposalAtomic(actorId, projectId, id);
    return this.visible(actorId, projectId, id);
  }
  async reject(actorId: string, projectId: string, id: string) {
    const proposal = await this.visible(actorId, projectId, id);
    if (proposal.status === "rejected") return proposal;
    if (proposal.status !== "pending")
      throw new AiError(409, "An applied proposal cannot be rejected");
    if (!(await this.options.store.reject(id)))
      throw new AiError(409, "Proposal status changed");
    return this.visible(actorId, projectId, id);
  }
}
