import { describe, expect, it, vi } from "vitest";
import { searchCitations, escapeBibtex } from "../src/research/index.js";
const paper = {
  DOI: "10.1234/Test",
  title: ["A {Title} & \\input{evil}"],
  author: [{ given: "Ada", family: "Lovelace" }],
  published: { "date-parts": [[2020, 1]] },
};
const jsonFetch = (body: unknown, status = 200) =>
  vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status }),
    );
const crossref = (items: unknown[]) => ({ status: "ok", message: { items } });
describe("fixed-provider citation search", () => {
  it("normalizes verified metadata, deterministic keys, escaped BibTeX and canonical DOI", async () => {
    const fetch = jsonFetch(crossref([paper]));
    const results = await searchCitations(
      { query: "x & url=http://internal", provider: "crossref" },
      { fetch, now: () => new Date("2026-01-01T00:00:00Z") },
    );
    expect(results[0]).toMatchObject({
      id: "crossref:10.1234/test",
      provider: "crossref",
      providerId: "10.1234/test",
      doi: "10.1234/test",
      url: "https://doi.org/10.1234/test",
      authors: ["Ada Lovelace"],
      year: 2020,
      retrievedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(results[0].bibtex).toContain(
      "A \\{Title\\} \\& \\textbackslash{}input\\{evil\\}",
    );
    expect(fetch.mock.calls[0][0].toString()).toMatch(
      /^https:\/\/api.crossref.org\/works\?/,
    );
    expect(fetch.mock.calls[0][1]?.redirect).toBe("error");
    const again = await searchCitations(
      { query: "different", provider: "crossref" },
      { fetch },
    );
    expect(again[0].bibtexKey).toBe(results[0].bibtexKey);
  });
  it("escapes every BibTeX control character", () => {
    expect(escapeBibtex("\\{}%&#_$~^")).toBe(
      "\\textbackslash{}\\{\\}\\%\\&\\#\\_\\$\\textasciitilde{}\\textasciicircum{}",
    );
  });
  it.each([
    { ...paper, author: [] },
    { ...paper, title: [""] },
    { ...paper, DOI: "http://internal" },
    { ...paper, author: [{ family: "\u0000" }] },
    { ...paper, published: { "date-parts": [[99999]] } },
  ])(
    "rejects invalid provider metadata without fabricating fallback",
    async (item) => {
      await expect(
        searchCitations(
          { query: "test", provider: "crossref" },
          { fetch: jsonFetch(crossref([item])) },
        ),
      ).rejects.toMatchObject({ code: "MALFORMED" });
    },
  );
  it("returns empty results only for a real empty provider collection", async () => {
    await expect(
      searchCitations(
        { query: "none", provider: "crossref" },
        { fetch: jsonFetch(crossref([])) },
      ),
    ).resolves.toEqual([]);
    await expect(
      searchCitations(
        { query: "none", provider: "crossref" },
        { fetch: jsonFetch({}) },
      ),
    ).rejects.toMatchObject({ code: "MALFORMED" });
  });
  it("does not invent missing year or journal", async () => {
    const undated = {
      DOI: paper.DOI,
      title: paper.title,
      author: paper.author,
    };
    const [item] = await searchCitations(
      { query: "test", provider: "crossref" },
      { fetch: jsonFetch(crossref([undated])) },
    );
    expect(item.year).toBeUndefined();
    expect(item.journal).toBeUndefined();
    expect(item.bibtex).not.toContain("year =");
  });
  it("normalizes Semantic Scholar without trusting provider URLs", async () => {
    const providerId = "a".repeat(40);
    const [item] = await searchCitations(
      { query: "test", provider: "semantic-scholar" },
      {
        fetch: jsonFetch({
          data: [
            {
              paperId: providerId,
              title: "Real title",
              authors: [{ name: "Real author" }],
              year: null,
              url: "http://internal",
              externalIds: { DOI: "10.1234/ABC" },
            },
          ],
        }),
      },
    );
    expect(item).toMatchObject({
      providerId,
      doi: "10.1234/abc",
      url: "https://doi.org/10.1234/abc",
    });
  });
  it("parses arXiv Atom with namespaces and rejects entities and malformed authors", async () => {
    const xml =
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2401.12345v2</id><title>Real &amp; verified paper</title><author><name>Ada</name></author><published>2024-01-01T00:00:00Z</published></entry></feed>';
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response(xml));
    const [item] = await searchCitations(
      { query: "test", provider: "arxiv" },
      { fetch },
    );
    expect(item.title).toBe("Real & verified paper");
    expect(item).toMatchObject({
      provider: "arxiv",
      providerId: "2401.12345v2",
      authors: ["Ada"],
      year: 2024,
    });
    fetch.mockImplementation(
      async () =>
        new Response(
          '<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + xml,
        ),
    );
    await expect(
      searchCitations({ query: "test", provider: "arxiv" }, { fetch }),
    ).rejects.toMatchObject({ code: "MALFORMED" });
    fetch.mockImplementation(
      async () => new Response(xml.replace("<name>Ada</name>", "<name/>")),
    );
    await expect(
      searchCitations({ query: "test", provider: "arxiv" }, { fetch }),
    ).rejects.toMatchObject({ code: "MALFORMED" });
  });
  it("bounds the query, response bytes and result count", async () => {
    const fetch = jsonFetch(crossref([paper, paper]));
    await expect(
      searchCitations({ query: "", provider: "crossref" }, { fetch }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      searchCitations(
        { query: "test", provider: "crossref", limit: 21 },
        { fetch },
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      searchCitations(
        { query: "test", provider: "crossref" },
        { fetch, maxResponseBytes: 4 },
      ),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
    expect(
      await searchCitations(
        { query: "test", provider: "crossref", limit: 1 },
        { fetch },
      ),
    ).toHaveLength(1);
  });
  it("reports timeout even if the fetch mock ignores abort", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    await expect(
      searchCitations(
        { query: "test", provider: "crossref" },
        { fetch, timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it("bounds declared response size and times out while reading a stalled body", async () => {
    const oversized = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("{}", { headers: { "content-length": "9999999" } }),
      );
    await expect(
      searchCitations(
        { query: "test", provider: "crossref" },
        { fetch: oversized },
      ),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
    const stalled = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
        }),
      ),
    );
    await expect(
      searchCitations(
        { query: "test", provider: "crossref" },
        { fetch: stalled, timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it("requires a verified zero result count for an empty arXiv feed", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(
        async () => new Response("<feed><unexpected/></feed>"),
      );
    await expect(
      searchCitations({ query: "test", provider: "arxiv" }, { fetch }),
    ).rejects.toMatchObject({ code: "MALFORMED" });
    fetch.mockImplementation(
      async () =>
        new Response(
          '<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>0</opensearch:totalResults></feed>',
        ),
    );
    await expect(
      searchCitations({ query: "test", provider: "arxiv" }, { fetch }),
    ).resolves.toEqual([]);
  });
  it("reports rate limits, upstream HTTP and transport errors explicitly", async () => {
    await expect(
      searchCitations(
        { query: "test", provider: "crossref" },
        { fetch: jsonFetch({}, 429) },
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
    await expect(
      searchCitations(
        { query: "test", provider: "crossref" },
        { fetch: jsonFetch({}, 503) },
      ),
    ).rejects.toMatchObject({ code: "UPSTREAM" });
    await expect(
      searchCitations(
        { query: "test", provider: "crossref" },
        {
          fetch: vi
            .fn<typeof fetch>()
            .mockRejectedValue(new Error("secret URL")),
        },
      ),
    ).rejects.toMatchObject({
      code: "UPSTREAM",
      message: "Citation provider could not be reached.",
    });
  });
});
