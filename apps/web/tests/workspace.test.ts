import { beforeEach, describe, expect, it, vi } from "vitest";
import { createJSONStorage } from "zustand/middleware";
import { useWorkspace } from "../src/stores/workspace";
import { api } from "../src/lib/api";
import type { Project } from "@latex-free/shared";
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
const project: Project = {
  id: "project",
  name: "Original",
  template: "blank",
  starred: false,
  updatedAt: new Date().toISOString(),
  files: [
    { id: "file", path: "main.tex", content: "Original source", version: 0 },
  ],
};
const { storage } = vi.hoisted(() => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
  });
  return { storage };
});
useWorkspace.persist.setOptions({
  storage: createJSONStorage(() => ({
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      storage.set(key, value);
    },
    removeItem: (key) => {
      storage.delete(key);
    },
  })),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.mocked(api).mockReset();
  storage.clear();
  useWorkspace.setState({
    localProjects: [],
    projects: structuredClone([project]),
    mode: "account",
    accountId: "alice",
    dirty: {},
    saving: {},
    error: null,
  });
});
describe("account draft lifecycle", () => {
  it("keeps an edit made while a rename is in flight", async () => {
    const response = deferred<unknown>();
    vi.mocked(api).mockReturnValueOnce(response.promise);
    const rename = useWorkspace.getState().renameProject("project", "New name");
    useWorkspace.getState().editFile("project", "file", "Work in progress");
    response.resolve({});
    await rename;
    expect(useWorkspace.getState().projects[0].name).toBe("New name");
    expect(useWorkspace.getState().projects[0].files[0].content).toBe(
      "Work in progress",
    );
  });
  it("retains changes typed during a save and uses the new version next time", async () => {
    const response = deferred<unknown>();
    vi.mocked(api).mockReturnValueOnce(response.promise);
    useWorkspace.getState().editFile("project", "file", "First draft");
    const saving = useWorkspace.getState().saveFile("project", "file");
    useWorkspace.getState().editFile("project", "file", "Second draft");
    response.resolve({
      file: { ...project.files[0], content: "First draft", version: 1 },
    });
    await saving;
    expect(useWorkspace.getState().dirty.file).toBe(true);
    expect(useWorkspace.getState().projects[0].files[0].content).toBe(
      "Second draft",
    );
    vi.mocked(api).mockResolvedValueOnce({
      file: { ...project.files[0], content: "Second draft", version: 2 },
    });
    await useWorkspace.getState().saveFile("project", "file");
    expect(JSON.parse(vi.mocked(api).mock.calls[1][1]!.body as string)).toEqual(
      { content: "Second draft", version: 1 },
    );
    expect(useWorkspace.getState().dirty.file).toBe(false);
  });
  it("keeps a draft dirty after the server rejects a save", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Conflict"));
    useWorkspace.getState().editFile("project", "file", "Keep this draft");
    await expect(
      useWorkspace.getState().saveFile("project", "file"),
    ).rejects.toThrow("Conflict");
    expect(useWorkspace.getState().dirty.file).toBe(true);
    expect(useWorkspace.getState().saving.file).toBe(false);
  });
  it("never leaks a late account response into local browser persistence", async () => {
    const response = deferred<unknown>();
    vi.mocked(api).mockReturnValueOnce(response.promise);
    const creating = useWorkspace
      .getState()
      .createProject("Private project", "blank");
    await useWorkspace.getState().connect(null);
    response.resolve({ project });
    await expect(creating).rejects.toThrow("workspace changed");
    expect(useWorkspace.getState().projects).toEqual([]);
    expect(useWorkspace.getState().localProjects).toEqual([]);
    expect([...storage.values()].join("")).not.toContain("Original source");
  });
});
