import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAccessTokens } from "../src/stores/access-tokens";
import { useWorkspace } from "../src/stores/workspace";
import { api } from "../src/lib/api";
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
const metadata = {
  id: "token-id",
  userId: "alice",
  label: "Research client",
  scopes: ["projects:read", "files:read"] as const,
  projectIds: ["project-id"],
  createdAt: "2026-11-01T00:00:00Z",
  expiresAt: "2026-12-01T00:00:00Z",
  revokedAt: null,
};
const input = {
  label: metadata.label,
  scopes: ["projects:read", "files:read"] as ("projects:read" | "files:read")[],
  projectIds: metadata.projectIds,
  expiresInDays: 30,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.mocked(api).mockReset();
  useWorkspace.setState({ mode: "account", accountId: "alice" });
  useAccessTokens.getState().reset();
});
describe("account access token metadata", () => {
  it("returns the one-time secret directly and caches only selected metadata fields", async () => {
    const secret = "fixture-secret-never-persisted";
    vi.mocked(api).mockResolvedValueOnce({
      token: secret,
      metadata: { ...metadata, token: secret },
    });
    expect(await useAccessTokens.getState().createToken(input)).toBe(secret);
    expect(api).toHaveBeenCalledWith("/tokens", {
      method: "POST",
      body: JSON.stringify(input),
    });
    expect(useAccessTokens.getState().tokens).toEqual([metadata]);
    expect(JSON.stringify(useAccessTokens.getState())).not.toContain(secret);
    vi.mocked(api).mockResolvedValueOnce({
      tokens: [{ ...metadata, token: secret }],
    });
    await useAccessTokens.getState().load();
    expect(JSON.stringify(useAccessTokens.getState())).not.toContain(secret);
  });
  it("clears metadata and suppresses late list and secret responses across account switches", async () => {
    vi.mocked(api).mockResolvedValueOnce({ tokens: [metadata] });
    await useAccessTokens.getState().load();
    const list = deferred<unknown>(),
      creation = deferred<unknown>();
    vi.mocked(api)
      .mockReturnValueOnce(list.promise)
      .mockReturnValueOnce(creation.promise);
    const loading = useAccessTokens.getState().load();
    const creating = useAccessTokens.getState().createToken(input);
    useWorkspace.setState({ accountId: "bob" });
    expect(useAccessTokens.getState().tokens).toEqual([]);
    useWorkspace.setState({ accountId: "alice" });
    list.resolve({ tokens: [metadata] });
    creation.resolve({ token: "old-account-secret", metadata });
    await loading;
    expect(await creating).toBeUndefined();
    expect(useAccessTokens.getState().tokens).toEqual([]);
    expect(useAccessTokens.getState().busy).toBe(false);
  });
  it("ignores older lists after a successful creation", async () => {
    const response = deferred<unknown>();
    vi.mocked(api)
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce({ token: "one-time", metadata });
    const loading = useAccessTokens.getState().load();
    await useAccessTokens.getState().createToken(input);
    response.resolve({ tokens: [] });
    await loading;
    expect(useAccessTokens.getState().tokens).toEqual([metadata]);
    expect(useAccessTokens.getState().loading).toBe(false);
  });
  it("keeps active metadata when revocation fails and marks revoked only on server success", async () => {
    vi.mocked(api).mockResolvedValueOnce({ tokens: [metadata] });
    await useAccessTokens.getState().load();
    vi.mocked(api).mockRejectedValueOnce(new Error("Could not revoke token"));
    await expect(
      useAccessTokens.getState().revoke(metadata.id),
    ).rejects.toThrow("Could not revoke token");
    expect(useAccessTokens.getState().tokens[0].revokedAt).toBeNull();
    expect(useAccessTokens.getState().error).toBe("Could not revoke token");
    vi.mocked(api).mockResolvedValueOnce(undefined);
    await useAccessTokens.getState().revoke(metadata.id);
    expect(api).toHaveBeenLastCalledWith("/tokens/token-id", {
      method: "DELETE",
    });
    expect(useAccessTokens.getState().tokens[0].revokedAt).toBeTruthy();
  });
  it("clears metadata on signout and rejects local token actions", async () => {
    vi.mocked(api).mockResolvedValueOnce({ tokens: [metadata] });
    await useAccessTokens.getState().load();
    useWorkspace.setState({ mode: "local", accountId: null });
    expect(useAccessTokens.getState().tokens).toEqual([]);
    await expect(useAccessTokens.getState().createToken(input)).rejects.toThrow(
      "Sign in",
    );
    await expect(useAccessTokens.getState().load()).rejects.toThrow("Sign in");
    expect(api).toHaveBeenCalledTimes(1);
  });
});
