import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectDetails } from "../src/stores/project-details";
import { useWorkspace } from "../src/stores/workspace";
import { api } from "../src/lib/api";
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
const member = {
  userId: "bob",
  name: "Bob",
  email: "bob@example.com",
  image: null,
  role: "EDITOR",
};
const metadata = {
  id: "r1",
  version: 1,
  path: "main.tex",
  reason: "edit",
  createdAt: "2026-11-01T00:00:00Z",
  author: { id: "bob", name: "Bob" },
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
  useProjectDetails.getState().reset();
});
describe("project details state", () => {
  it("updates the member list only after successful server mutations and exposes errors", async () => {
    vi.mocked(api).mockResolvedValueOnce({ members: [member] });
    await useProjectDetails.getState().loadMembers("p");
    const response = deferred<unknown>();
    vi.mocked(api).mockReturnValueOnce(response.promise);
    const changing = useProjectDetails
      .getState()
      .changeRole("p", "bob", "VIEWER");
    expect(useProjectDetails.getState().loading["members:p"]).toBe(true);
    expect(useProjectDetails.getState().members.p[0].role).toBe("EDITOR");
    response.resolve({ member: { ...member, role: "VIEWER" } });
    await changing;
    expect(useProjectDetails.getState().members.p[0].role).toBe("VIEWER");
    vi.mocked(api).mockRejectedValueOnce(new Error("Owner access required"));
    await expect(
      useProjectDetails.getState().removeMember("p", "bob"),
    ).rejects.toThrow("Owner access required");
    expect(useProjectDetails.getState().members.p).toHaveLength(1);
    expect(useProjectDetails.getState().errors["members:p"]).toBe(
      "Owner access required",
    );
    vi.mocked(api).mockResolvedValueOnce(undefined);
    await useProjectDetails.getState().removeMember("p", "bob");
    expect(useProjectDetails.getState().members.p).toEqual([]);
  });
  it("paginates revisions, deduplicates metadata, and stores loaded snapshot content", async () => {
    vi.mocked(api).mockResolvedValueOnce({
      revisions: [metadata],
      nextCursor: "older cursor",
    });
    await useProjectDetails.getState().loadRevisions("p", "f");
    vi.mocked(api).mockResolvedValueOnce({
      revisions: [metadata, { ...metadata, id: "r0", version: 0 }],
      nextCursor: null,
    });
    await useProjectDetails.getState().loadRevisions("p", "f", true);
    expect(vi.mocked(api).mock.calls[1][0]).toContain("cursor=older%20cursor");
    expect(
      useProjectDetails.getState().revisions.f.revisions.map((r) => r.id),
    ).toEqual(["r1", "r0"]);
    vi.mocked(api).mockResolvedValueOnce({
      revision: { ...metadata, content: "Private text" },
    });
    await useProjectDetails.getState().loadRevision("p", "f", "r1");
    expect(useProjectDetails.getState().details.r1.content).toBe(
      "Private text",
    );
  });
  it("clears private cached details on account switches and ignores late responses even after switching back", async () => {
    vi.mocked(api).mockResolvedValueOnce({ members: [member] });
    await useProjectDetails.getState().loadMembers("p");
    const response = deferred<unknown>();
    vi.mocked(api).mockReturnValueOnce(response.promise);
    const loading = useProjectDetails.getState().loadRevision("p", "f", "r1");
    useWorkspace.setState({ accountId: "other" });
    expect(useProjectDetails.getState().members).toEqual({});
    useWorkspace.setState({ accountId: "alice" });
    response.resolve({
      revision: { ...metadata, content: "Private old text" },
    });
    await loading;
    expect(useProjectDetails.getState().details).toEqual({});
    expect(useProjectDetails.getState().loading).toEqual({});
  });
  it("does not let an older list response replace a newer fetch", async () => {
    const response = deferred<unknown>();
    vi.mocked(api)
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce({ members: [{ ...member, role: "VIEWER" }] });
    const first = useProjectDetails.getState().loadMembers("p");
    await useProjectDetails.getState().loadMembers("p");
    response.resolve({ members: [member] });
    await first;
    expect(useProjectDetails.getState().members.p[0].role).toBe("VIEWER");
  });
});
