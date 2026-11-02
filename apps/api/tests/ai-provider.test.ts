import { beforeEach, describe, expect, it, vi } from "vitest";
const { create, construct } = vi.hoisted(() => ({
  create: vi.fn(),
  construct: vi.fn(),
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
    constructor(options: unknown) {
      construct(options);
    }
  },
}));
import { createClaudeProvider } from "../src/ai/provider.js";
const input = {
  domain: "resume" as const,
  instruction: "Shorten.",
  files: [
    { id: "f1", path: "main.tex", content: "Existing facts", version: 2 },
  ],
  citations: [],
};
describe("Claude proposal provider", () => {
  beforeEach(() => {
    create.mockReset();
    construct.mockClear();
  });
  it("uses the server key, explicit configured model and forced structured tool without mutation tools", async () => {
    const result = {
      summary: "Shortened",
      edits: [{ fileId: "f1", content: "Facts" }],
      citationKeys: [],
    };
    create.mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "propose_edits", input: result }],
    });
    const provider = createClaudeProvider({
      apiKey: "server-only-secret",
      model: "explicit-admin-model",
    })!;
    const signal = new AbortController().signal;
    expect(await provider.generate(input, signal)).toEqual(result);
    expect(construct).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "server-only-secret", maxRetries: 0 }),
    );
    const [payload, options] = create.mock.calls[0];
    expect(payload.model).toBe("explicit-admin-model");
    expect(payload.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "propose_edits",
    ]);
    expect(payload.tool_choice).toEqual({
      type: "tool",
      name: "propose_edits",
    });
    expect(payload.max_tokens).toBe(8192);
    expect(JSON.stringify(payload)).not.toContain("server-only-secret");
    expect(options.signal).toBe(signal);
    expect(payload.system).toContain("do not invent");
  });
  it.each([
    { stop_reason: "max_tokens", content: [] },
    { stop_reason: "tool_use", content: [{ type: "text", text: "{}" }] },
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "write_file", input: {} }],
    },
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", name: "propose_edits", input: {} },
        { type: "tool_use", name: "propose_edits", input: {} },
      ],
    },
  ])("rejects incomplete or unexpected tool output", async (response) => {
    create.mockResolvedValue(response);
    await expect(
      createClaudeProvider({
        apiKey: "server-only-secret",
        model: "explicit-admin-model",
      })!.generate(input, new AbortController().signal),
    ).rejects.toThrow();
  });
});
