"use client";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  initialFiles,
  templates,
  createFileSchema,
  importProjectSchema,
  pathsCollide,
  fileByteLength,
  MAX_PROJECT_FILES,
  MAX_PROJECT_BYTES,
  restoreTrashedFileSchema,
  type TrashedFile,
  type Project,
  type ProjectFile,
  type TemplateId,
} from "@latex-free/shared";
import { api } from "@/lib/api";
import {
  closeCleanCollaborations,
  evictCollaboration,
  getCollaboration,
  type CollaborationState,
} from "@/lib/collaboration";

export type ImportFile = Pick<
  ProjectFile,
  "path" | "content" | "encoding" | "mimeType"
>;
type Draft = {
  projectId: string;
  fileId: string;
  content: string;
  version: number;
};
type Workspace = {
  localProjects: Project[];
  localTrash: Record<string, (ProjectFile & { deletedAt: string })[]>;
  accountTrash: Record<string, TrashedFile[]>;
  loadTrash: (pid: string) => Promise<void>;
  restoreTrashedFile: (
    pid: string,
    fid: string,
    version: number,
    path?: string,
  ) => Promise<void>;
  purgeTrashedFile: (
    pid: string,
    fid: string,
    version: number,
  ) => Promise<void>;
  projects: Project[];
  mode: "local" | "account";
  accountId: string | null;
  hydrated: boolean;
  loading: boolean;
  error: string | null;
  section: "projects" | "starred" | "templates";
  query: string;
  view: "grid" | "list";
  sort: "updated" | "name";
  dirty: Record<string, boolean>;
  saving: Record<string, boolean>;
  saveErrors: Record<string, string>;
  conflicts: Record<string, ProjectFile | null>;
  pendingRecovery: Draft[];
  collaborationManaged: Record<string, boolean>;
  projectCollaboration: (
    pid: string,
    fid: string,
    content: string,
    state: CollaborationState,
  ) => void;
  refreshCollaborationProject: (pid: string) => Promise<void>;
  recoverCollaborationDraft: (
    pid: string,
    fid: string,
    expectedVersion: number,
  ) => Promise<void>;
  setHydrated: () => void;
  setFilter: (
    filter: Partial<Pick<Workspace, "section" | "query" | "view" | "sort">>,
  ) => void;
  connect: (userId: string | null) => Promise<void>;
  createProject: (name: string, template: TemplateId) => Promise<string>;
  importProject: (name: string, files: ImportFile[]) => Promise<string>;
  renameProject: (id: string, name: string) => Promise<void>;
  toggleStar: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  addFile: (projectId: string, path: string) => Promise<string>;
  addAsset: (
    projectId: string,
    path: string,
    content: string,
    encoding?: "utf8" | "base64",
    mimeType?: string | null,
  ) => Promise<string>;
  renameFile: (
    projectId: string,
    fileId: string,
    path: string,
  ) => Promise<void>;
  deleteFile: (projectId: string, fileId: string) => Promise<void>;
  editFile: (projectId: string, fileId: string, content: string) => void;
  saveFile: (projectId: string, fileId: string) => Promise<void>;
  restoreRevision: (
    projectId: string,
    fileId: string,
    revisionId: string,
  ) => Promise<void>;
  startAutosave: () => () => void;
  acceptRemote: (projectId: string, fileId: string) => void;
  keepDraft: (projectId: string, fileId: string) => Promise<void>;
  recoverDrafts: () => void;
  discardRecovery: () => void;
};
function localProject(
  name: string,
  template: TemplateId,
  files = initialFiles(template),
): Project {
  return {
    id: crypto.randomUUID(),
    name,
    template,
    starred: false,
    updatedAt: new Date().toISOString(),
    files: files.map((file) => ({
      ...file,
      id: crypto.randomUUID(),
      version: 0,
    })),
  };
}
const recoveryKey = (account: string) =>
  `latex-free-account-drafts-v1:${encodeURIComponent(account)}`;
export const useWorkspace = create<Workspace>()(
  persist(
    (set, get) => {
      let epoch = 0;
      let autosaveUsers = 0;
      const timers = new Map<string, ReturnType<typeof setTimeout>>();
      const operations = new Map<string, Promise<void>>();
      const file = (pid: string, fid: string) =>
        get()
          .projects.find((p) => p.id === pid)
          ?.files.find((f) => f.id === fid);
      function context() {
        const generation = epoch,
          mode = get().mode,
          account = get().accountId;
        const valid = () =>
          generation === epoch &&
          mode === get().mode &&
          account === get().accountId;
        return {
          valid,
          check: () => {
            if (!valid())
              throw new Error("Your workspace changed. Please try again.");
          },
        };
      }
      function cancelTimers() {
        timers.forEach(clearTimeout);
        timers.clear();
      }
      function persistDrafts() {
        if (
          get().mode !== "account" ||
          !get().accountId ||
          get().loading ||
          get().error
        )
          return;
        const drafts: Draft[] = [...get().pendingRecovery];
        for (const project of get().projects)
          for (const f of project.files)
            if (get().dirty[f.id]) {
              const index = drafts.findIndex((d) => d.fileId === f.id);
              if (index >= 0) drafts.splice(index, 1);
              drafts.push({
                projectId: project.id,
                fileId: f.id,
                content: f.content,
                version: f.version,
              });
            }
        try {
          if (drafts.length)
            sessionStorage.setItem(
              recoveryKey(get().accountId!),
              JSON.stringify(drafts),
            );
          else sessionStorage.removeItem(recoveryKey(get().accountId!));
        } catch {
          /* Storage may be unavailable or full; the in-memory draft remains. */
        }
      }
      function validateStored(
        pid: string,
        active: (ProjectFile | ImportFile)[],
      ) {
        const stored = [
          ...active,
          ...(get().mode === "local" ? (get().localTrash[pid] ?? []) : []),
        ];
        if (
          stored.length > MAX_PROJECT_FILES ||
          stored.reduce((bytes, file) => bytes + fileByteLength(file), 0) >
            MAX_PROJECT_BYTES
        )
          throw new Error(
            "Project storage limit includes files in Trash. Permanently delete unneeded trashed files to free space.",
          );
      }
      function evictDeleted(pid: string, f: ProjectFile) {
        const account = get().accountId;
        if (!account) return;
        const session = getCollaboration(account, pid, f.id);
        if (get().dirty[f.id] || session?.snapshot().dirty) {
          const draft = {
            projectId: pid,
            fileId: f.id,
            content: session?.text.toString() ?? f.content,
            version: f.version,
          };
          set((s) => ({
            pendingRecovery: [
              ...s.pendingRecovery.filter((d) => d.fileId !== f.id),
              draft,
            ],
          }));
        }
        evictCollaboration(account, pid, f.id);
        clearTimeout(timers.get(f.id));
      }
      function replaceProject(project: Project) {
        set((s) => {
          const projects = s.projects.map((p) =>
            p.id === project.id ? project : p,
          );
          return {
            projects,
            ...(s.mode === "local" ? { localProjects: projects } : {}),
          };
        });
      }
      function updateFile(
        pid: string,
        fid: string,
        update: (f: ProjectFile) => ProjectFile,
      ) {
        const p = get().projects.find((p) => p.id === pid);
        if (p)
          replaceProject({
            ...p,
            updatedAt: new Date().toISOString(),
            files: p.files.map((f) => (f.id === fid ? update(f) : f)),
          });
      }
      function addProject(project: Project) {
        set((s) => {
          const projects = [project, ...s.projects];
          return {
            projects,
            ...(s.mode === "account"
              ? {
                  collaborationManaged: {
                    ...s.collaborationManaged,
                    ...Object.fromEntries(
                      project.files
                        .filter((f) => f.encoding !== "base64")
                        .map((f) => [f.id, true]),
                    ),
                  },
                }
              : {}),
            section: "projects",
            query: "",
            ...(s.mode === "local" ? { localProjects: projects } : {}),
          };
        });
      }
      function clearStatus(fid: string) {
        set((s) => {
          const saveErrors = { ...s.saveErrors },
            conflicts = { ...s.conflicts };
          delete saveErrors[fid];
          delete conflicts[fid];
          return { saveErrors, conflicts };
        });
      }
      function reportError(fid: string, error: unknown) {
        const e = error as {
          message?: string;
          status?: number;
          data?: { file?: ProjectFile };
        };
        set((s) => ({
          saveErrors: {
            ...s.saveErrors,
            [fid]: e.message ?? "Could not save this file",
          },
          ...(e.status === 409
            ? { conflicts: { ...s.conflicts, [fid]: e.data?.file ?? null } }
            : {}),
        }));
      }
      function schedule(pid: string, fid: string) {
        if (
          !autosaveUsers ||
          get().mode !== "account" ||
          !get().dirty[fid] ||
          get().collaborationManaged[fid] ||
          fid in get().conflicts ||
          get().saveErrors[fid]
        )
          return;
        clearTimeout(timers.get(fid));
        timers.set(
          fid,
          setTimeout(() => {
            timers.delete(fid);
            void get()
              .saveFile(pid, fid)
              .catch(() => {});
          }, 800),
        );
      }
      async function serialize(fid: string, task: () => Promise<void>) {
        const previous = operations.get(fid);
        const pending = previous ? previous.catch(() => {}).then(task) : task();
        operations.set(fid, pending);
        try {
          await pending;
        } finally {
          if (operations.get(fid) === pending) operations.delete(fid);
        }
      }
      return {
        localProjects: [],
        localTrash: {},
        accountTrash: {},
        projects: [],
        mode: "local",
        accountId: null,
        hydrated: false,
        loading: false,
        error: null,
        section: "projects",
        query: "",
        view: "grid",
        sort: "updated",
        dirty: {},
        saving: {},
        saveErrors: {},
        conflicts: {},
        pendingRecovery: [],
        collaborationManaged: {},
        projectCollaboration: (pid, fid, content, state) => {
          if (get().mode !== "account") return;
          set((s) => ({
            collaborationManaged: { ...s.collaborationManaged, [fid]: true },
            dirty: { ...s.dirty, [fid]: state.dirty },
            saving: { ...s.saving, [fid]: state.saving },
          }));
          if (state.ready)
            updateFile(pid, fid, (f) => ({
              ...f,
              content,
              ...(state.version !== null ? { version: state.version } : {}),
            }));
          persistDrafts();
        },
        refreshCollaborationProject: async (pid) => {
          const ctx = context();
          const { projects } = await api<{ projects: Project[] }>("/projects");
          if (!ctx.valid()) return;
          const fresh = projects.find((p) => p.id === pid);
          const current = get().projects.find((p) => p.id === pid);
          if (!current) return;
          if (!fresh) {
            replaceProject({ ...current, role: "VIEWER" });
            return;
          }
          for (const previous of current.files)
            if (!fresh.files.some((f) => f.id === previous.id))
              evictDeleted(pid, previous);
          replaceProject({
            ...fresh,
            files: fresh.files.map((f) => {
              const session =
                get().accountId &&
                getCollaboration(get().accountId!, pid, f.id);
              return session && session.snapshot().ready
                ? { ...f, content: session.text.toString() }
                : f;
            }),
          });
          persistDrafts();
        },
        recoverCollaborationDraft: async (pid, fid, expectedVersion) => {
          const ctx = context();
          const draft = get().pendingRecovery.find(
            (d) => d.projectId === pid && d.fileId === fid,
          );
          const project = get().projects.find((p) => p.id === pid);
          if (
            !draft ||
            !project ||
            project.role === "VIEWER" ||
            get().mode !== "account"
          )
            throw new Error("You need edit access to recover this draft.");
          const session =
            get().accountId && getCollaboration(get().accountId!, pid, fid);
          if (
            session &&
            (session.snapshot().dirty ||
              !session.snapshot().synchronized ||
              session.snapshot().blocked)
          )
            throw new Error(
              "Save or resolve the live document before recovering a draft.",
            );
          const { file: recovered } = await api<{ file: ProjectFile }>(
            `/projects/${pid}/files/${fid}`,
            {
              method: "PUT",
              body: JSON.stringify({
                content: draft.content,
                version: expectedVersion,
              }),
            },
          );
          ctx.check();
          // The server updates the live Y.Doc. Never insert a JSON recovery draft into it here.
          if (!session) updateFile(pid, fid, () => recovered);
          set((s) => ({
            pendingRecovery: s.pendingRecovery.filter((d) => d !== draft),
          }));
          persistDrafts();
        },
        setHydrated: () =>
          set((s) => ({
            hydrated: true,
            ...(s.mode === "local" ? { projects: s.localProjects } : {}),
          })),
        setFilter: (filter) => set(filter),
        connect: async (userId) => {
          if (
            userId &&
            get().accountId === userId &&
            get().mode === "account" &&
            !get().error
          )
            return;
          persistDrafts();
          closeCleanCollaborations(userId ?? undefined);
          epoch++;
          cancelTimers();
          operations.clear();
          set((s) => ({
            mode: userId ? "account" : "local",
            accountId: userId,
            projects: userId ? [] : s.localProjects,
            loading: !!userId,
            error: null,
            dirty: {},
            saving: {},
            saveErrors: {},
            conflicts: {},
            pendingRecovery: [],
            collaborationManaged: {},
            accountTrash: {},
          }));
          if (!userId) return;
          const ctx = context();
          try {
            const { projects } = await api<{ projects: Project[] }>(
              "/projects",
            );
            if (!ctx.valid()) return;
            let pendingRecovery: Draft[] = [];
            try {
              const parsed: unknown = JSON.parse(
                sessionStorage.getItem(recoveryKey(userId)) ?? "[]",
              );
              if (Array.isArray(parsed))
                pendingRecovery = parsed.filter(
                  (d): d is Draft =>
                    d &&
                    typeof d.projectId === "string" &&
                    typeof d.fileId === "string" &&
                    typeof d.content === "string" &&
                    Number.isInteger(d.version) &&
                    d.version >= 0,
                );
            } catch {
              /* Recovery is best effort. */
            }
            set({
              projects,
              loading: false,
              pendingRecovery,
              collaborationManaged: Object.fromEntries(
                projects.flatMap((p) =>
                  p.files
                    .filter((f) => f.encoding !== "base64")
                    .map((f) => [f.id, true]),
                ),
              ),
            });
          } catch (error) {
            if (ctx.valid())
              set({ loading: false, error: (error as Error).message });
          }
        },
        createProject: async (name, template) => {
          const ctx = context();
          const project =
            get().mode === "local"
              ? localProject(name, template)
              : (
                  await api<{ project: Project }>("/projects", {
                    method: "POST",
                    body: JSON.stringify({ name, template }),
                  })
                ).project;
          ctx.check();
          addProject(project);
          return project.id;
        },
        importProject: async (name, files) => {
          const input = importProjectSchema.parse({ name, files });
          const ctx = context();
          const project =
            get().mode === "local"
              ? {
                  ...localProject(input.name, "blank"),
                  files: input.files.map((f) => ({
                    ...f,
                    id: crypto.randomUUID(),
                    version: 0,
                  })),
                }
              : (
                  await api<{ project: Project }>("/projects/import", {
                    method: "POST",
                    body: JSON.stringify(input),
                  })
                ).project;
          ctx.check();
          addProject(project);
          return project.id;
        },
        renameProject: async (id, name) => {
          const ctx = context();
          if (!get().projects.some((p) => p.id === id)) return;
          if (get().mode === "account")
            await api(`/projects/${id}`, {
              method: "PATCH",
              body: JSON.stringify({ name }),
            });
          ctx.check();
          const current = get().projects.find((p) => p.id === id);
          if (current)
            replaceProject({
              ...current,
              name,
              updatedAt: new Date().toISOString(),
            });
        },
        toggleStar: async (id) => {
          const ctx = context(),
            p = get().projects.find((p) => p.id === id);
          if (!p) return;
          if (get().mode === "account")
            await api(`/projects/${id}`, {
              method: "PATCH",
              body: JSON.stringify({ starred: !p.starred }),
            });
          ctx.check();
          const current = get().projects.find((p) => p.id === id);
          if (current) replaceProject({ ...current, starred: !p.starred });
        },
        deleteProject: async (id) => {
          const ctx = context();
          if (get().mode === "account")
            await api(`/projects/${id}`, { method: "DELETE" });
          ctx.check();
          set((s) => {
            const projects = s.projects.filter((p) => p.id !== id);
            const dirty = { ...s.dirty };
            const localTrash = { ...s.localTrash },
              accountTrash = { ...s.accountTrash };
            if (s.mode === "local") delete localTrash[id];
            else delete accountTrash[id];
            s.projects
              .find((p) => p.id === id)
              ?.files.forEach((f) => {
                delete dirty[f.id];
                clearTimeout(timers.get(f.id));
              });
            return {
              projects,
              dirty,
              localTrash,
              accountTrash,
              pendingRecovery: s.pendingRecovery.filter(
                (d) => d.projectId !== id,
              ),
              ...(s.mode === "local" ? { localProjects: projects } : {}),
            };
          });
          persistDrafts();
        },
        addFile: (pid, path) => get().addAsset(pid, path, "", "utf8"),
        addAsset: async (pid, path, content, encoding = "base64", mimeType) => {
          const input = createFileSchema.parse({
            path,
            content,
            encoding,
            mimeType,
          });
          const ctx = context();
          const p = get().projects.find((p) => p.id === pid);
          if (!p) throw new Error("Project not found");
          if (p.files.some((f) => pathsCollide(f.path, input.path)))
            throw new Error("A file with this path already exists");
          validateStored(pid, [...p.files, input]);
          const created =
            get().mode === "local"
              ? { ...input, id: crypto.randomUUID(), version: 0 }
              : (
                  await api<{ file: ProjectFile }>(`/projects/${pid}/files`, {
                    method: "POST",
                    body: JSON.stringify(input),
                  })
                ).file;
          ctx.check();
          const current = get().projects.find((p) => p.id === pid);
          if (!current) throw new Error("Project not found");
          replaceProject({
            ...current,
            files: [...current.files, created],
            updatedAt: new Date().toISOString(),
          });
          if (get().mode === "account" && created.encoding !== "base64")
            set((s) => ({
              collaborationManaged: {
                ...s.collaborationManaged,
                [created.id]: true,
              },
            }));
          return created.id;
        },
        renameFile: async (pid, fid, path) => {
          if (get().collaborationManaged[fid]) await get().saveFile(pid, fid);
          const ctx = context();
          await serialize(fid, async () => {
            ctx.check();
            const f = file(pid, fid);
            if (!f) throw new Error("File not found");
            const input = createFileSchema.parse({ ...f, path });
            if (
              get()
                .projects.find((p) => p.id === pid)!
                .files.some(
                  (other) =>
                    other.id !== fid && pathsCollide(other.path, input.path),
                )
            )
              throw new Error("A file with this path already exists");
            try {
              const renamed =
                get().mode === "local"
                  ? { ...f, path: input.path }
                  : (
                      await api<{ file: ProjectFile }>(
                        `/projects/${pid}/files/${fid}`,
                        {
                          method: "PATCH",
                          body: JSON.stringify({
                            path: input.path,
                            version: f.version,
                          }),
                        },
                      )
                    ).file;
              ctx.check();
              updateFile(pid, fid, (current) => ({
                ...current,
                path: renamed.path,
                version: renamed.version,
              }));
              clearStatus(fid);
              persistDrafts();
            } catch (error) {
              if (ctx.valid()) reportError(fid, error);
              throw error;
            }
          });
        },
        deleteFile: async (pid, fid) => {
          if (get().collaborationManaged[fid]) await get().saveFile(pid, fid);
          const ctx = context();
          await serialize(fid, async () => {
            ctx.check();
            const f = file(pid, fid);
            if (!f) return;
            try {
              if (get().mode === "account")
                await api(
                  `/projects/${pid}/files/${fid}?version=${f.version}`,
                  { method: "DELETE" },
                );
              ctx.check();
              if (get().mode === "local")
                set((s) => ({
                  localTrash: {
                    ...s.localTrash,
                    [pid]: [
                      ...(s.localTrash[pid] ?? []),
                      {
                        ...f,
                        version: f.version + 1,
                        deletedAt: new Date().toISOString(),
                      },
                    ],
                  },
                }));
              else evictDeleted(pid, f);
              const current = get().projects.find((p) => p.id === pid);
              if (current)
                replaceProject({
                  ...current,
                  files: current.files.filter((f) => f.id !== fid),
                  updatedAt: new Date().toISOString(),
                });
              clearTimeout(timers.get(fid));
              clearStatus(fid);
              set((s) => ({
                dirty: { ...s.dirty, [fid]: false },
              }));
              persistDrafts();
            } catch (error) {
              if (ctx.valid()) reportError(fid, error);
              throw error;
            }
          });
        },
        loadTrash: async (pid) => {
          if (get().mode === "local") return;
          const ctx = context();
          const { files } = await api<{ files: TrashedFile[] }>(
            `/projects/${pid}/trash`,
          );
          ctx.check();
          set((s) => ({ accountTrash: { ...s.accountTrash, [pid]: files } }));
        },
        restoreTrashedFile: async (pid, fid, version, path) => {
          const ctx = context();
          const input = restoreTrashedFileSchema.parse({
            version,
            path: path || undefined,
          });
          const project = get().projects.find((p) => p.id === pid);
          if (!project) throw new Error("Project not found");
          let restored: ProjectFile;
          if (get().mode === "local") {
            const trashed = get().localTrash[pid]?.find((f) => f.id === fid);
            if (!trashed || trashed.version !== version)
              throw new Error("Trash changed. Refresh and try again.");
            const destination = input.path ?? trashed.path;
            if (project.files.some((f) => pathsCollide(f.path, destination)))
              throw new Error(
                "Restore path collides with an active file. Choose another path.",
              );
            const { deletedAt: _deletedAt, ...file } = trashed;
            void _deletedAt;
            restored = {
              ...file,
              path: destination,
              version: file.version + 1,
            };
            set((s) => ({
              localTrash: {
                ...s.localTrash,
                [pid]: s.localTrash[pid].filter((f) => f.id !== fid),
              },
            }));
          } else {
            restored = (
              await api<{ file: ProjectFile }>(
                `/projects/${pid}/trash/${fid}/restore`,
                { method: "POST", body: JSON.stringify(input) },
              )
            ).file;
            ctx.check();
            evictCollaboration(get().accountId!, pid, fid);
            set((s) => ({
              accountTrash: {
                ...s.accountTrash,
                [pid]: (s.accountTrash[pid] ?? []).filter((f) => f.id !== fid),
              },
              collaborationManaged: {
                ...s.collaborationManaged,
                [fid]: restored.encoding !== "base64",
              },
            }));
          }
          const current = get().projects.find((p) => p.id === pid);
          if (current)
            replaceProject({
              ...current,
              files: [...current.files.filter((f) => f.id !== fid), restored],
              updatedAt: new Date().toISOString(),
            });
          clearStatus(fid);
        },
        purgeTrashedFile: async (pid, fid, version) => {
          const ctx = context();
          if (get().mode === "local") {
            const trashed = get().localTrash[pid]?.find((f) => f.id === fid);
            if (!trashed || trashed.version !== version)
              throw new Error("Trash changed. Refresh and try again.");
            set((s) => ({
              localTrash: {
                ...s.localTrash,
                [pid]: s.localTrash[pid].filter((f) => f.id !== fid),
              },
            }));
          } else {
            await api(`/projects/${pid}/trash/${fid}?version=${version}`, {
              method: "DELETE",
            });
            ctx.check();
            set((s) => ({
              accountTrash: {
                ...s.accountTrash,
                [pid]: (s.accountTrash[pid] ?? []).filter((f) => f.id !== fid),
              },
            }));
          }
        },
        editFile: (pid, fid, content) => {
          if (get().mode === "account" && get().collaborationManaged[fid])
            return;
          const f = file(pid, fid);
          if (!f || f.encoding === "base64" || f.content === content) return;
          if (get().mode === "local") {
            try {
              createFileSchema.parse({ ...f, content });
              validateStored(
                pid,
                get()
                  .projects.find((p) => p.id === pid)!
                  .files.map((other) =>
                    other.id === fid ? { ...other, content } : other,
                  ),
              );
            } catch (error) {
              reportError(fid, error);
              return;
            }
          }
          updateFile(pid, fid, (f) => ({ ...f, content }));
          if (get().mode === "account") {
            set((s) => ({ dirty: { ...s.dirty, [fid]: true } }));
            persistDrafts();
            schedule(pid, fid);
          }
        },
        saveFile: async (pid, fid) => {
          if (get().mode === "account" && get().collaborationManaged[fid]) {
            const session =
              get().accountId && getCollaboration(get().accountId!, pid, fid);
            if (session) {
              await session.save();
              return;
            }
            if (get().dirty[fid])
              throw new Error(
                "Open this live document and synchronize before saving.",
              );
            return;
          }
          const ctx = context();
          await serialize(fid, async () => {
            ctx.check();
            const f = file(pid, fid);
            if (!f || get().mode === "local" || !get().dirty[fid]) return;
            if (fid in get().conflicts)
              throw new Error("Resolve this file's conflict before saving.");
            set((s) => ({ saving: { ...s.saving, [fid]: true } }));
            try {
              const result = await api<{ file: ProjectFile }>(
                `/projects/${pid}/files/${fid}`,
                {
                  method: "PUT",
                  body: JSON.stringify({
                    content: f.content,
                    version: f.version,
                  }),
                },
              );
              ctx.check();
              const current = file(pid, fid);
              if (current) {
                updateFile(pid, fid, (f) => ({
                  ...f,
                  version: result.file.version,
                }));
                set((s) => ({
                  dirty: { ...s.dirty, [fid]: current.content !== f.content },
                }));
                clearStatus(fid);
                persistDrafts();
              }
            } catch (error) {
              if (ctx.valid()) {
                reportError(fid, error);
                persistDrafts();
              }
              throw error;
            } finally {
              if (ctx.valid()) {
                set((s) => ({ saving: { ...s.saving, [fid]: false } }));
                schedule(pid, fid);
              }
            }
          });
        },
        restoreRevision: async (pid, fid, rid) => {
          const ctx = context();
          const checkRestore = () => {
            ctx.check();
            if (get().mode !== "account")
              throw new Error("Sign in to restore file history.");
            const project = get().projects.find((p) => p.id === pid);
            if (!project || project.role === "VIEWER")
              throw new Error("You need edit access to restore a revision.");
            if (
              get().dirty[fid] ||
              fid in get().conflicts ||
              get().pendingRecovery.some((draft) => draft.fileId === fid)
            )
              throw new Error(
                "Save or resolve your draft before restoring a revision.",
              );
          };
          checkRestore();
          if (get().collaborationManaged[fid]) await get().saveFile(pid, fid);
          await serialize(fid, async () => {
            checkRestore();
            const original = file(pid, fid);
            if (!original || original.encoding === "base64")
              throw new Error("Text file not found.");
            clearTimeout(timers.get(fid));
            set((s) => ({ saving: { ...s.saving, [fid]: true } }));
            try {
              const { file: restored } = await api<{ file: ProjectFile }>(
                `/projects/${pid}/files/${fid}/revisions/${rid}/restore`,
                {
                  method: "POST",
                  body: JSON.stringify({ expectedVersion: original.version }),
                },
              );
              ctx.check();
              const current = file(pid, fid);
              if (current) {
                const edited = !!get().dirty[fid];
                updateFile(pid, fid, (actual) => ({
                  ...restored,
                  ...(edited ? { content: actual.content } : {}),
                }));
                set((s) => ({ dirty: { ...s.dirty, [fid]: edited } }));
                clearStatus(fid);
                persistDrafts();
              }
            } catch (error) {
              if (ctx.valid()) {
                reportError(fid, error);
                persistDrafts();
              }
              throw error;
            } finally {
              if (ctx.valid()) {
                set((s) => ({ saving: { ...s.saving, [fid]: false } }));
                schedule(pid, fid);
              }
            }
          });
        },
        startAutosave: () => {
          autosaveUsers++;
          for (const p of get().projects)
            for (const f of p.files) schedule(p.id, f.id);
          let stopped = false;
          return () => {
            if (stopped) return;
            stopped = true;
            autosaveUsers = Math.max(0, autosaveUsers - 1);
            if (!autosaveUsers) cancelTimers();
          };
        },
        acceptRemote: (pid, fid) => {
          const remote = get().conflicts[fid];
          if (!remote) return;
          updateFile(pid, fid, () => remote);
          set((s) => ({ dirty: { ...s.dirty, [fid]: false } }));
          clearStatus(fid);
          persistDrafts();
        },
        keepDraft: async (pid, fid) => {
          const remote = get().conflicts[fid];
          if (!remote)
            throw new Error(
              "The remote file is unavailable. Download your draft before reloading.",
            );
          updateFile(pid, fid, (f) => ({
            ...f,
            path: remote.path,
            version: remote.version,
          }));
          clearStatus(fid);
          set((s) => ({ dirty: { ...s.dirty, [fid]: true } }));
          await get().saveFile(pid, fid);
        },
        recoverDrafts: () => {
          for (const draft of get().pendingRecovery) {
            const current = file(draft.projectId, draft.fileId);
            if (
              !current ||
              current.encoding === "base64" ||
              get().collaborationManaged[draft.fileId]
            )
              continue;
            updateFile(draft.projectId, draft.fileId, (f) => ({
              ...f,
              content: draft.content,
            }));
            set((s) => ({
              dirty: { ...s.dirty, [draft.fileId]: true },
              ...(current.version !== draft.version
                ? {
                    conflicts: { ...s.conflicts, [draft.fileId]: current },
                    saveErrors: {
                      ...s.saveErrors,
                      [draft.fileId]:
                        "The account copy changed since this recovered draft.",
                    },
                  }
                : {}),
            }));
            schedule(draft.projectId, draft.fileId);
          }
          // Retain drafts whose files no longer exist so the UI can still offer their text.
          set((s) => ({
            pendingRecovery: s.pendingRecovery.filter(
              (d) =>
                !file(d.projectId, d.fileId) ||
                get().collaborationManaged[d.fileId],
            ),
          }));
          persistDrafts();
        },
        discardRecovery: () => {
          set({ pendingRecovery: [] });
          persistDrafts();
        },
      };
    },
    {
      name: "latex-free-workspace-v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        localProjects: s.localProjects,
        localTrash: s.localTrash,
        view: s.view,
        sort: s.sort,
      }),
      skipHydration: true,
    },
  ),
);
export { templates };
