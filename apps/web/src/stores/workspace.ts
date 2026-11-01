"use client";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  initialFiles,
  templates,
  type Project,
  type ProjectFile,
  type TemplateId,
} from "@latex-free/shared";
import { api } from "@/lib/api";

type Mode = "local" | "account";
type Section = "projects" | "starred" | "templates";
type Workspace = {
  localProjects: Project[];
  projects: Project[];
  mode: Mode;
  accountId: string | null;
  hydrated: boolean;
  loading: boolean;
  error: string | null;
  section: Section;
  query: string;
  view: "grid" | "list";
  sort: "updated" | "name";
  dirty: Record<string, boolean>;
  saving: Record<string, boolean>;
  setHydrated: () => void;
  setFilter: (
    filter: Partial<Pick<Workspace, "section" | "query" | "view" | "sort">>,
  ) => void;
  connect: (userId: string | null) => Promise<void>;
  createProject: (name: string, template: TemplateId) => Promise<string>;
  renameProject: (id: string, name: string) => Promise<void>;
  toggleStar: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  addFile: (projectId: string, path: string) => Promise<string>;
  editFile: (projectId: string, fileId: string, content: string) => void;
  saveFile: (projectId: string, fileId: string) => Promise<void>;
};
function newLocalProject(name: string, template: TemplateId): Project {
  return {
    id: crypto.randomUUID(),
    name,
    template,
    starred: false,
    updatedAt: new Date().toISOString(),
    files: initialFiles(template).map((file) => ({
      ...file,
      id: crypto.randomUUID(),
      version: 0,
    })),
  };
}
export const useWorkspace = create<Workspace>()(
  persist(
    (set, get) => {
      function captureContext() {
        const { mode, accountId } = get();
        return () => {
          if (get().mode !== mode || get().accountId !== accountId)
            throw new Error("Your workspace changed. Please try again.");
        };
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
      return {
        localProjects: [],
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
        setHydrated: () =>
          set((s) => ({ hydrated: true, projects: s.localProjects })),
        setFilter: (filter) => set(filter),
        connect: async (userId) => {
          if (!userId) {
            set((s) => ({
              mode: "local",
              accountId: null,
              projects: s.localProjects,
              loading: false,
              error: null,
              dirty: {},
            }));
            return;
          }
          if (
            get().accountId === userId &&
            get().mode === "account" &&
            !get().error
          )
            return;
          set({
            loading: true,
            mode: "account",
            accountId: userId,
            projects: [],
            dirty: {},
            error: null,
          });
          try {
            const { projects } = await api<{ projects: Project[] }>(
              "/projects",
            );
            if (get().accountId === userId) set({ projects, loading: false });
          } catch (error) {
            if (get().accountId === userId)
              set({ loading: false, error: (error as Error).message });
          }
        },
        createProject: async (name, template) => {
          const checkContext = captureContext();
          const project =
            get().mode === "local"
              ? newLocalProject(name, template)
              : (
                  await api<{ project: Project }>("/projects", {
                    method: "POST",
                    body: JSON.stringify({ name, template }),
                  })
                ).project;
          checkContext();
          set((s) => {
            const projects = [project, ...s.projects];
            return {
              projects,
              section: "projects",
              query: "",
              ...(s.mode === "local" ? { localProjects: projects } : {}),
            };
          });
          return project.id;
        },
        renameProject: async (id, name) => {
          const checkContext = captureContext();
          const project = get().projects.find((p) => p.id === id);
          if (!project) return;
          if (get().mode === "account")
            await api(`/projects/${id}`, {
              method: "PATCH",
              body: JSON.stringify({ name }),
            });
          checkContext();
          replaceProject({
            ...get().projects.find((p) => p.id === id)!,
            name,
            updatedAt: new Date().toISOString(),
          });
        },
        toggleStar: async (id) => {
          const checkContext = captureContext();
          const project = get().projects.find((p) => p.id === id);
          if (!project) return;
          if (get().mode === "account")
            await api(`/projects/${id}`, {
              method: "PATCH",
              body: JSON.stringify({ starred: !project.starred }),
            });
          checkContext();
          replaceProject({
            ...get().projects.find((p) => p.id === id)!,
            starred: !project.starred,
          });
        },
        deleteProject: async (id) => {
          const checkContext = captureContext();
          if (get().mode === "account")
            await api(`/projects/${id}`, { method: "DELETE" });
          checkContext();
          set((s) => {
            const projects = s.projects.filter((p) => p.id !== id);
            return {
              projects,
              ...(s.mode === "local" ? { localProjects: projects } : {}),
            };
          });
        },
        addFile: async (projectId, path) => {
          const checkContext = captureContext();
          const project = get().projects.find((p) => p.id === projectId);
          if (!project) throw new Error("Project not found");
          if (project.files.some((f) => f.path === path))
            throw new Error("A file with this name already exists");
          const file =
            get().mode === "local"
              ? { id: crypto.randomUUID(), path, content: "", version: 0 }
              : (
                  await api<{ file: ProjectFile }>(
                    `/projects/${projectId}/files`,
                    { method: "POST", body: JSON.stringify({ path }) },
                  )
                ).file;
          checkContext();
          const current = get().projects.find((p) => p.id === projectId)!;
          replaceProject({
            ...current,
            files: [...current.files, file],
            updatedAt: new Date().toISOString(),
          });
          return file.id;
        },
        editFile: (projectId, fileId, content) => {
          const project = get().projects.find((p) => p.id === projectId);
          if (!project) return;
          replaceProject({
            ...project,
            updatedAt: new Date().toISOString(),
            files: project.files.map((f) =>
              f.id === fileId ? { ...f, content } : f,
            ),
          });
          if (get().mode === "account")
            set((s) => ({ dirty: { ...s.dirty, [fileId]: true } }));
        },
        saveFile: async (projectId, fileId) => {
          const checkContext = captureContext();
          const file = get()
            .projects.find((p) => p.id === projectId)
            ?.files.find((f) => f.id === fileId);
          if (
            !file ||
            get().mode === "local" ||
            !get().dirty[fileId] ||
            get().saving[fileId]
          )
            return;
          set((s) => ({ saving: { ...s.saving, [fileId]: true } }));
          try {
            const result = await api<{ file: ProjectFile }>(
              `/projects/${projectId}/files/${fileId}`,
              {
                method: "PUT",
                body: JSON.stringify({
                  content: file.content,
                  version: file.version,
                }),
              },
            );
            checkContext();
            const current = get().projects.find((p) => p.id === projectId);
            if (current) {
              const currentFile = current.files.find((f) => f.id === fileId)!;
              replaceProject({
                ...current,
                files: current.files.map((f) =>
                  f.id === fileId ? { ...f, version: result.file.version } : f,
                ),
              });
              set((s) => ({
                dirty: {
                  ...s.dirty,
                  [fileId]: currentFile.content !== file.content,
                },
              }));
            }
          } finally {
            set((s) => ({ saving: { ...s.saving, [fileId]: false } }));
          }
        },
      };
    },
    {
      name: "latex-free-workspace-v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        localProjects: s.localProjects,
        view: s.view,
        sort: s.sort,
      }),
      skipHydration: true,
    },
  ),
);
export { templates };
