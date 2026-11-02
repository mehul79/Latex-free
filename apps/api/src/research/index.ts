import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";

export const citationProviderSchema = z.enum([
  "crossref",
  "arxiv",
  "semantic-scholar",
]);
export type CitationProvider = z.infer<typeof citationProviderSchema>;
const text = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((value) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));
export const citationCandidateSchema = z
  .object({
    id: text,
    provider: citationProviderSchema,
    providerId: text,
    title: text,
    authors: z.array(text).min(1).max(200),
    year: z.number().int().min(1000).max(3000).optional(),
    journal: text.optional(),
    doi: text.optional(),
    url: z.string().url(),
    retrievedAt: z.string().datetime(),
    bibtexKey: z.string().regex(/^ref_[a-f0-9]{16}$/),
    bibtex: z.string().min(1).max(200000),
  })
  .strict();
export type CitationCandidate = z.infer<typeof citationCandidateSchema>;
export class CitationSearchError extends Error {
  constructor(
    public readonly code:
      | "INVALID_REQUEST"
      | "TIMEOUT"
      | "RATE_LIMIT"
      | "UPSTREAM"
      | "TOO_LARGE"
      | "MALFORMED",
    message: string,
  ) {
    super(message);
    this.name = "CitationSearchError";
  }
}
export interface CitationSearchRequest {
  query: string;
  provider: CitationProvider;
  limit?: number;
}
export interface CitationSearchOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => Date;
}
type Metadata = {
  providerId: string;
  title: string;
  authors: string[];
  year?: number;
  journal?: string;
  doi?: string;
  url: string;
};
const metadataSchema = z
  .object({
    providerId: text,
    title: text,
    authors: z.array(text).min(1).max(200),
    year: z.number().int().min(1000).max(3000).optional(),
    journal: text.optional(),
    doi: text.optional(),
    url: z.string().url(),
  })
  .strict();
const doiSchema = z
  .string()
  .trim()
  .regex(/^10\.\d{4,9}\/[^\s<>"{}]+$/i)
  .max(500);
function canonicalDoi(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return doiSchema
    .parse(
      typeof value === "string"
        ? value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
        : value,
    )
    .toLowerCase();
}
export function escapeBibtex(value: string): string {
  const escapes: Record<string, string> = {
    "\\": "\\textbackslash{}",
    "{": "\\{",
    "}": "\\}",
    "%": "\\%",
    "&": "\\&",
    "#": "\\#",
    _: "\\_",
    $: "\\$",
    "~": "\\textasciitilde{}",
    "^": "\\textasciicircum{}",
  };
  return value
    .replace(/[\\{}%&#_$~^]/g, (char) => escapes[char])
    .replace(/[\r\n\t]+/g, " ");
}
function candidate(
  provider: CitationProvider,
  input: Metadata,
  retrievedAt: string,
): CitationCandidate {
  const data = metadataSchema.parse(input);
  const id = `${provider}:${data.providerId}`;
  const bibtexKey = `ref_${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
  const fields: [string, string][] = [
    ["title", data.title],
    [
      "author",
      data.authors.map((name) => `{${escapeBibtex(name)}}`).join(" and "),
    ],
  ];
  if (data.year !== undefined) fields.push(["year", String(data.year)]);
  if (data.journal) fields.push(["journal", data.journal]);
  if (data.doi) fields.push(["doi", data.doi]);
  fields.push(["url", data.url]);
  const bibtex = `@article{${bibtexKey},\n${fields.map(([key, value]) => `  ${key} = {${key === "author" ? value : escapeBibtex(value)}}`).join(",\n")}\n}`;
  return citationCandidateSchema.parse({
    ...data,
    id,
    provider,
    retrievedAt,
    bibtexKey,
    bibtex,
  });
}
const obj = z.record(z.string(), z.unknown());
function crossref(raw: unknown): Metadata[] {
  const envelope = z
    .object({
      status: z.literal("ok"),
      message: z.object({ items: z.array(obj).max(1000) }),
    })
    .parse(raw);
  return envelope.message.items.map((item) => {
    const doi = canonicalDoi(item.DOI);
    if (!doi) throw new Error("Missing DOI");
    const authors = z
      .array(obj)
      .min(1)
      .max(200)
      .parse(item.author)
      .map((author) => {
        if (author.name !== undefined) return text.parse(author.name);
        const given =
          author.given === undefined ? "" : text.parse(author.given);
        return [given, text.parse(author.family)].filter(Boolean).join(" ");
      });
    const dates =
      item.published ??
      item["published-print"] ??
      item["published-online"] ??
      item.issued;
    const year =
      dates === undefined
        ? undefined
        : z
            .object({
              "date-parts": z
                .array(z.array(z.number().int()).min(1).max(3))
                .min(1),
            })
            .parse(dates)["date-parts"][0][0];
    return {
      providerId: doi,
      doi,
      title: z.array(text).min(1).parse(item.title)[0],
      authors,
      year,
      journal:
        item["container-title"] === undefined
          ? undefined
          : z.array(text).parse(item["container-title"])[0],
      url: `https://doi.org/${doi}`,
    };
  });
}
function semanticScholar(raw: unknown): Metadata[] {
  return z
    .object({ data: z.array(obj).max(1000) })
    .parse(raw)
    .data.map((item) => {
      const providerId = z
        .string()
        .regex(/^[a-f0-9]{40}$/i)
        .parse(item.paperId);
      const identifiers =
        item.externalIds == null ? {} : obj.parse(item.externalIds);
      const doi = canonicalDoi(identifiers.DOI);
      const journal =
        item.journal == null
          ? undefined
          : z.object({ name: text.optional() }).parse(item.journal).name;
      return {
        providerId,
        title: text.parse(item.title),
        authors: z
          .array(z.object({ name: text }))
          .min(1)
          .max(200)
          .parse(item.authors)
          .map((a) => a.name),
        year: item.year == null ? undefined : z.number().int().parse(item.year),
        journal,
        doi,
        url: doi
          ? `https://doi.org/${doi}`
          : `https://www.semanticscholar.org/paper/${providerId}`,
      };
    });
}
function arxiv(raw: string): Metadata[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(raw) || XMLValidator.validate(raw) !== true)
    throw new Error("Invalid Atom XML");
  const parsed = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    processEntities: true,
    isArray: (name) => name === "entry" || name === "author",
  }).parse(raw);
  const feed = z.object({ feed: obj }).parse(parsed).feed;
  if (feed.entry === undefined) {
    z.string().regex(/^0$/).parse(feed.totalResults);
    return [];
  }
  return z
    .array(obj)
    .max(1000)
    .parse(feed.entry)
    .map((entry) => {
      const id = z
        .string()
        .regex(
          /^https?:\/\/arxiv\.org\/abs\/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)$/,
        )
        .parse(entry.id);
      const providerId = id.replace(/^https?:\/\/arxiv\.org\/abs\//, "");
      const published = z.string().datetime().parse(entry.published);
      const doi = canonicalDoi(entry.doi);
      return {
        providerId,
        title: text.parse(entry.title).replace(/\s+/g, " "),
        authors: z
          .array(z.object({ name: text }))
          .min(1)
          .max(200)
          .parse(entry.author)
          .map((a) => a.name),
        year: Number(published.slice(0, 4)),
        doi,
        journal:
          entry.journal_ref === undefined
            ? undefined
            : text.parse(entry.journal_ref),
        url: `https://arxiv.org/abs/${providerId}`,
      };
    });
}

/** Searches fixed public provider endpoints. Results are provider metadata, never model-generated citations. */
export async function searchCitations(
  request: CitationSearchRequest,
  options: CitationSearchOptions = {},
): Promise<CitationCandidate[]> {
  const validated = z
    .object({
      query: z.string().trim().min(1).max(500),
      provider: citationProviderSchema,
      limit: z.number().int().min(1).max(20).default(5),
    })
    .strict()
    .safeParse(request);
  if (!validated.success)
    throw new CitationSearchError(
      "INVALID_REQUEST",
      "Citation search requires a query, supported provider, and limit from 1 to 20.",
    );
  const { query, provider, limit } = validated.data;
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxBytes = options.maxResponseBytes ?? 1024 * 1024;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 2 * 1024 * 1024
  )
    throw new CitationSearchError(
      "INVALID_REQUEST",
      "Invalid citation transport limits.",
    );
  const url = new URL(
    provider === "crossref"
      ? "https://api.crossref.org/works"
      : provider === "arxiv"
        ? "https://export.arxiv.org/api/query"
        : "https://api.semanticscholar.org/graph/v1/paper/search",
  );
  if (provider === "crossref") {
    url.searchParams.set("query", query);
    url.searchParams.set("rows", String(limit));
  } else if (provider === "arxiv") {
    url.searchParams.set("search_query", `all:${query}`);
    url.searchParams.set("max_results", String(limit));
  } else {
    url.searchParams.set("query", query);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set(
      "fields",
      "paperId,title,authors,year,journal,externalIds",
    );
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = async () => {
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      signal: controller.signal,
      redirect: "error",
      headers: {
        Accept:
          provider === "arxiv" ? "application/atom+xml" : "application/json",
      },
    });
    if (response.status === 429)
      throw new CitationSearchError(
        "RATE_LIMIT",
        "Citation provider rate limit reached. Try again later.",
      );
    if (!response.ok)
      throw new CitationSearchError(
        "UPSTREAM",
        `Citation provider returned HTTP ${response.status}.`,
      );
    const declaredLength = response.headers.get("content-length");
    if (declaredLength && Number(declaredLength) > maxBytes) {
      await response.body?.cancel();
      throw new CitationSearchError(
        "TOO_LARGE",
        "Citation provider response exceeded the byte limit.",
      );
    }
    if (!response.body)
      throw new CitationSearchError(
        "MALFORMED",
        "Citation provider returned an empty response body.",
      );
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new CitationSearchError(
            "TOO_LARGE",
            "Citation provider response exceeded the byte limit.",
          );
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = Buffer.concat(chunks).toString("utf8");
    try {
      const metadata =
        provider === "arxiv"
          ? arxiv(body)
          : provider === "crossref"
            ? crossref(JSON.parse(body))
            : semanticScholar(JSON.parse(body));
      const retrievedAt = (options.now ?? (() => new Date()))().toISOString();
      return metadata
        .slice(0, limit)
        .map((item) => candidate(provider, item, retrievedAt));
    } catch {
      throw new CitationSearchError(
        "MALFORMED",
        "Citation provider returned invalid or incomplete citation metadata.",
      );
    }
  };
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new CitationSearchError(
              "TIMEOUT",
              "Citation provider request timed out.",
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof CitationSearchError) throw error;
    if (controller.signal.aborted)
      throw new CitationSearchError(
        "TIMEOUT",
        "Citation provider request timed out.",
      );
    throw new CitationSearchError(
      "UPSTREAM",
      "Citation provider could not be reached.",
    );
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
