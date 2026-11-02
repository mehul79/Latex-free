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
    saveErrors: {},
    conflicts: {},
    pendingRecovery: [],
    collaborationManaged: {},
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

describe("file operations and autosave", () => {
  it("serializes rename after content save without losing a newer draft", async () => {
    const response = deferred<unknown>();
    vi.mocked(api)
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce({
        file: { ...project.files[0], path: "chapters/main.tex", version: 2 },
      });
    useWorkspace.getState().editFile("project", "file", "Saved draft");
    const saving = useWorkspace.getState().saveFile("project", "file");
    const rename = useWorkspace
      .getState()
      .renameFile("project", "file", "chapters/main.tex");
    useWorkspace.getState().editFile("project", "file", "Newest draft");
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
    response.resolve({
      file: { ...project.files[0], content: "Saved draft", version: 1 },
    });
    await Promise.all([saving, rename]);
    expect(JSON.parse(vi.mocked(api).mock.calls[1][1]!.body as string)).toEqual(
      { path: "chapters/main.tex", version: 1 },
    );
    expect(useWorkspace.getState().projects[0].files[0]).toMatchObject({
      content: "Newest draft",
      path: "chapters/main.tex",
      version: 2,
    });
    expect(useWorkspace.getState().dirty.file).toBe(true);
  });
  it("debounces edits and saves the next edit after an in-flight save", async () => {
    vi.useFakeTimers();
    const first = deferred<unknown>();
    vi.mocked(api)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ file: { ...project.files[0], version: 2 } });
    const stop = useWorkspace.getState().startAutosave();
    try {
      useWorkspace.getState().editFile("project", "file", "a");
      await vi.advanceTimersByTimeAsync(400);
      useWorkspace.getState().editFile("project", "file", "ab");
      await vi.advanceTimersByTimeAsync(799);
      expect(api).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(api).toHaveBeenCalledTimes(1);
      useWorkspace.getState().editFile("project", "file", "abc");
      first.resolve({
        file: { ...project.files[0], content: "ab", version: 1 },
      });
      await vi.advanceTimersByTimeAsync(800);
      expect(api).toHaveBeenCalledTimes(2);
      expect(
        JSON.parse(vi.mocked(api).mock.calls[1][1]!.body as string),
      ).toEqual({ content: "abc", version: 1 });
      expect(useWorkspace.getState().dirty.file).toBe(false);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
  it("exposes conflict data without overwriting a draft and requires explicit retry", async () => {
    const remote = { ...project.files[0], content: "Remote text", version: 4 };
    vi.mocked(api).mockRejectedValueOnce(
      Object.assign(new Error("Changed remotely"), {
        status: 409,
        data: { file: remote },
      }),
    );
    useWorkspace.getState().editFile("project", "file", "My draft");
    await expect(
      useWorkspace.getState().saveFile("project", "file"),
    ).rejects.toThrow("Changed remotely");
    expect(useWorkspace.getState().conflicts.file).toEqual(remote);
    expect(useWorkspace.getState().projects[0].files[0].content).toBe(
      "My draft",
    );
    await expect(
      useWorkspace.getState().saveFile("project", "file"),
    ).rejects.toThrow("Resolve");
    expect(api).toHaveBeenCalledTimes(1);
    vi.mocked(api).mockResolvedValueOnce({
      file: { ...remote, content: "My draft", version: 5 },
    });
    await useWorkspace.getState().keepDraft("project", "file");
    expect(JSON.parse(vi.mocked(api).mock.calls[1][1]!.body as string)).toEqual(
      { content: "My draft", version: 4 },
    );
    expect(useWorkspace.getState().conflicts.file).toBeUndefined();
  });
  it("accepts the remote version and clears the local dirty flag", async () => {
    const remote = { ...project.files[0], content: "Remote", version: 2 };
    useWorkspace.setState({
      dirty: { file: true },
      conflicts: { file: remote },
    });
    useWorkspace.getState().acceptRemote("project", "file");
    expect(useWorkspace.getState().projects[0].files[0]).toEqual(remote);
    expect(useWorkspace.getState().dirty.file).toBe(false);
  });
  it("rejects a response from a previous session of the same account", async () => {
    const first = deferred<unknown>();
    vi.mocked(api)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ projects: [structuredClone(project)] });
    useWorkspace
      .getState()
      .editFile("project", "file", "Old account session draft");
    const saving = useWorkspace.getState().saveFile("project", "file");
    await useWorkspace.getState().connect(null);
    await useWorkspace.getState().connect("alice");
    useWorkspace
      .getState()
      .projectCollaboration("project", "file", "New session draft", {
        connected: false,
        synchronized: false,
        ready: true,
        dirty: true,
        durable: false,
        saving: false,
        readOnly: false,
        blocked: false,
        error: null,
        version: 0,
        peers: 1,
      });
    first.resolve({ file: { ...project.files[0], version: 99 } });
    await expect(saving).rejects.toThrow("workspace changed");
    expect(useWorkspace.getState().projects[0].files[0]).toMatchObject({
      content: "New session draft",
      version: 0,
    });
    expect(useWorkspace.getState().dirty.file).toBe(true);
  });
  it("retains local file drafts through rename and validates path collisions", async () => {
    useWorkspace.setState({ mode: "local", accountId: null });
    useWorkspace.getState().editFile("project", "file", "Local draft");
    await useWorkspace
      .getState()
      .renameFile("project", "file", "sections/intro.tex");
    expect(useWorkspace.getState().localProjects[0].files[0]).toMatchObject({
      path: "sections/intro.tex",
      content: "Local draft",
    });
    await expect(
      useWorkspace.getState().addFile("project", "sections"),
    ).rejects.toThrow("already exists");
    await expect(
      useWorkspace.getState().addFile("project", "../bad.tex"),
    ).rejects.toThrow();
    await useWorkspace.getState().deleteFile("project", "file");
    expect(useWorkspace.getState().localProjects[0].files).toEqual([]);
    expect(api).not.toHaveBeenCalled();
  });
});

describe("account session recovery", () => {
  it("isolates recovery by account and asks before restoring a stale draft", async () => {
    const session = new Map<string, string>();
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => session.get(key) ?? null,
        setItem: (key: string, value: string) => session.set(key, value),
        removeItem: (key: string) => session.delete(key),
      },
    });
    useWorkspace.getState().editFile("project", "file", "Private Alice draft");
    await useWorkspace.getState().connect(null);
    vi.mocked(api).mockResolvedValueOnce({
      projects: [structuredClone(project)],
    });
    await useWorkspace.getState().connect("bob");
    expect(useWorkspace.getState().pendingRecovery).toEqual([]);
    expect(useWorkspace.getState().projects[0].files[0].content).toBe(
      "Original source",
    );
    await useWorkspace.getState().connect(null);
    vi.mocked(api).mockResolvedValueOnce({
      projects: [
        {
          ...project,
          files: [
            { ...project.files[0], content: "New remote source", version: 3 },
          ],
        },
      ],
    });
    await useWorkspace.getState().connect("alice");
    expect(useWorkspace.getState().projects[0].files[0].content).toBe(
      "New remote source",
    );
    expect(useWorkspace.getState().pendingRecovery[0].content).toBe(
      "Private Alice draft",
    );
    useWorkspace.getState().recoverDrafts();
    expect(useWorkspace.getState().projects[0].files[0].content).toBe(
      "New remote source",
    );
    expect(useWorkspace.getState().pendingRecovery[0].content).toBe(
      "Private Alice draft",
    );
    expect(useWorkspace.getState().conflicts.file).toBeUndefined();
    expect([...storage.values()].join("")).not.toContain("Private Alice draft");
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  });
});

describe("revision restore", () => {
  it("refuses unsaved and conflicted drafts without sending a restore", async () => {
    useWorkspace.getState().editFile("project", "file", "My unsaved work");
    await expect(
      useWorkspace.getState().restoreRevision("project", "file", "revision"),
    ).rejects.toThrow("draft");
    expect(api).not.toHaveBeenCalled();
    useWorkspace.setState({ dirty: {}, conflicts: { file: project.files[0] } });
    await expect(
      useWorkspace.getState().restoreRevision("project", "file", "revision"),
    ).rejects.toThrow("draft");
    expect(useWorkspace.getState().projects[0].files[0].content).toBe(
      "My unsaved work",
    );
    expect(api).not.toHaveBeenCalled();
  });
  it("merges the restored server version while preserving text typed during restore", async () => {
    const response = deferred<unknown>();
    vi.mocked(api).mockReturnValueOnce(response.promise);
    const restoring = useWorkspace
      .getState()
      .restoreRevision("project", "file", "revision");
    expect(useWorkspace.getState().saving.file).toBe(true);
    useWorkspace.getState().editFile("project", "file", "Typed during restore");
    response.resolve({
      file: { ...project.files[0], content: "Older saved text", version: 1 },
    });
    await restoring;
    expect(vi.mocked(api).mock.calls[0][0]).toBe(
      "/projects/project/files/file/revisions/revision/restore",
    );
    expect(JSON.parse(vi.mocked(api).mock.calls[0][1]!.body as string)).toEqual(
      { expectedVersion: 0 },
    );
    expect(useWorkspace.getState().projects[0].files[0]).toMatchObject({
      content: "Typed during restore",
      version: 1,
      path: "main.tex",
    });
    expect(useWorkspace.getState().dirty.file).toBe(true);
    vi.mocked(api).mockResolvedValueOnce({
      file: {
        ...project.files[0],
        content: "Typed during restore",
        version: 2,
      },
    });
    await useWorkspace.getState().saveFile("project", "file");
    expect(
      JSON.parse(vi.mocked(api).mock.calls[1][1]!.body as string).version,
    ).toBe(1);
  });
  it("restores a clean file and reports conflicts without discarding its content", async () => {
    vi.mocked(api).mockResolvedValueOnce({
      file: { ...project.files[0], content: "Restored text", version: 1 },
    });
    await useWorkspace
      .getState()
      .restoreRevision("project", "file", "revision");
    expect(useWorkspace.getState().projects[0].files[0].content).toBe(
      "Restored text",
    );
    expect(useWorkspace.getState().dirty.file).toBe(false);
    const remote = {
      ...project.files[0],
      content: "Someone else's work",
      version: 2,
    };
    vi.mocked(api).mockRejectedValueOnce(
      Object.assign(new Error("File changed"), {
        status: 409,
        data: { file: remote },
      }),
    );
    await expect(
      useWorkspace.getState().restoreRevision("project", "file", "revision"),
    ).rejects.toThrow("File changed");
    expect(useWorkspace.getState().projects[0].files[0].content).toBe(
      "Restored text",
    );
    expect(useWorkspace.getState().conflicts.file).toEqual(remote);
  });
  it("rejects viewer restores and ignores restore results after switching accounts", async () => {
    useWorkspace.setState({
      projects: [{ ...structuredClone(project), role: "VIEWER" }],
    });
    await expect(
      useWorkspace.getState().restoreRevision("project", "file", "revision"),
    ).rejects.toThrow("edit access");
    expect(api).not.toHaveBeenCalled();
    useWorkspace.setState({ projects: structuredClone([project]) });
    const response = deferred<unknown>();
    vi.mocked(api).mockReturnValueOnce(response.promise);
    const restoring = useWorkspace
      .getState()
      .restoreRevision("project", "file", "revision");
    await useWorkspace.getState().connect(null);
    response.resolve({
      file: {
        ...project.files[0],
        content: "Private restored text",
        version: 1,
      },
    });
    await expect(restoring).rejects.toThrow("workspace changed");
    expect(useWorkspace.getState().projects).toEqual([]);
    expect(useWorkspace.getState().saving).toEqual({});
  });
});

describe("collaboration authority", () => {
  it("enrolls account text on connection and never REST autosaves its projected draft", async () => {
    vi.mocked(api).mockResolvedValueOnce({
      projects: structuredClone([project]),
    });
    await useWorkspace.getState().connect("collaborator");
    expect(useWorkspace.getState().collaborationManaged.file).toBe(true);
    useWorkspace
      .getState()
      .projectCollaboration("project", "file", "Live offline draft", {
        connected: false,
        synchronized: false,
        ready: true,
        dirty: true,
        durable: false,
        saving: false,
        readOnly: false,
        blocked: false,
        error: null,
        version: 0,
        peers: 1,
      });
    const stop = useWorkspace.getState().startAutosave();
    await expect(
      useWorkspace.getState().saveFile("project", "file"),
    ).rejects.toThrow("synchronize");
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
    expect(useWorkspace.getState().projects[0].files[0].content).toBe(
      "Live offline draft",
    );
    stop();
  });
  it("keeps JSON recovery separate from a managed Y.Doc projection", () => {
    useWorkspace.setState({
      collaborationManaged: { file: true },
      pendingRecovery: [
        {
          projectId: "project",
          fileId: "file",
          content: "Old JSON draft",
          version: 0,
        },
      ],
    });
    useWorkspace.getState().recoverDrafts();
    expect(useWorkspace.getState().projects[0].files[0].content).toBe(
      "Original source",
    );
    expect(useWorkspace.getState().pendingRecovery).toHaveLength(1);
    expect(vi.mocked(api)).not.toHaveBeenCalled();
  });
  it("recovers a reviewed draft only by a REST version compare-and-swap", async () => {
    useWorkspace.setState({
      collaborationManaged: { file: true },
      pendingRecovery: [
        {
          projectId: "project",
          fileId: "file",
          content: "Reviewed draft",
          version: 0,
        },
      ],
    });
    vi.mocked(api).mockResolvedValueOnce({
      file: { ...project.files[0], content: "Reviewed draft", version: 1 },
    });
    await useWorkspace
      .getState()
      .recoverCollaborationDraft("project", "file", 0);
    expect(vi.mocked(api)).toHaveBeenCalledWith(
      "/projects/project/files/file",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ content: "Reviewed draft", version: 0 }),
      }),
    );
    expect(useWorkspace.getState().pendingRecovery).toHaveLength(0);
  });
});
