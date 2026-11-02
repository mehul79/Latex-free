"use client";
import { create } from "zustand";
import { api, ApiError } from "@/lib/api";
import { useWorkspace } from "@/stores/workspace";

type Author = { id: string; name: string; image: string | null } | null;
export type FileComment = {
  id: string;
  authorId: string | null;
  author: Author;
  body: string;
  createdAt: string;
  updatedAt: string;
};
export type CommentThread = {
  id: string;
  resolvedAt: string | null;
  resolvedBy: Author;
  anchorStatus: "file" | "anchored" | "detached";
  comments: FileComment[];
};
type Page = { threads: CommentThread[]; nextCursor: string | null };
type State = {
  pages: Record<string, Page>;
  loading: Record<string, boolean>;
  busy: Record<string, boolean>;
  errors: Record<string, string>;
  reset(): void;
  load(projectId: string, fileId: string, more?: boolean): Promise<void>;
  change(
    projectId: string,
    fileId: string,
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body?: unknown,
  ): Promise<void>;
};
let epoch = 0;
const requests = new Map<string, number>();
const route = (project: string, file: string) =>
  `/projects/${encodeURIComponent(project)}/files/${encodeURIComponent(file)}/discussions`;
const empty = () => ({ pages: {}, loading: {}, busy: {}, errors: {} });
export const useComments = create<State>((set, get) => {
  function current() {
    const account = useWorkspace.getState();
    if (account.mode !== "account" || !account.accountId)
      throw new Error("Sign in to access comments.");
    const generation = epoch,
      id = account.accountId;
    return () =>
      epoch === generation &&
      useWorkspace.getState().accountId === id &&
      useWorkspace.getState().mode === "account";
  }
  function error(fileId: string, caught: unknown) {
    set((state) => ({
      errors: { ...state.errors, [fileId]: (caught as Error).message },
      ...(caught instanceof ApiError && [401, 404].includes(caught.status)
        ? {
            pages: {
              ...state.pages,
              [fileId]: { threads: [], nextCursor: null },
            },
          }
        : {}),
    }));
  }
  return {
    ...empty(),
    reset: () => {
      epoch++;
      requests.clear();
      set(empty());
    },
    load: async (projectId, fileId, more = false) => {
      const valid = current(),
        previous = get().pages[fileId];
      const serial = (requests.get(fileId) ?? 0) + 1;
      requests.set(fileId, serial);
      set((state) => ({ loading: { ...state.loading, [fileId]: true } }));
      try {
        const cursor = more && previous?.nextCursor;
        const result = await api<Page>(
          `${route(projectId, fileId)}/threads${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        if (valid() && requests.get(fileId) === serial)
          set((state) => ({
            pages: {
              ...state.pages,
              [fileId]: {
                ...result,
                threads: cursor
                  ? [...(previous?.threads ?? []), ...result.threads]
                  : result.threads,
              },
            },
            errors: { ...state.errors, [fileId]: "" },
          }));
      } catch (caught) {
        if (valid() && requests.get(fileId) === serial) error(fileId, caught);
      } finally {
        if (valid() && requests.get(fileId) === serial)
          set((state) => ({ loading: { ...state.loading, [fileId]: false } }));
      }
    },
    change: async (projectId, fileId, path, method, body) => {
      const valid = current();
      if (get().busy[fileId])
        throw new Error("A comment change is already in progress.");
      set((state) => ({
        busy: { ...state.busy, [fileId]: true },
        errors: { ...state.errors, [fileId]: "" },
      }));
      try {
        await api(`${route(projectId, fileId)}${path}`, {
          method,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (valid()) await get().load(projectId, fileId);
      } catch (caught) {
        if (valid()) error(fileId, caught);
        throw caught;
      } finally {
        if (valid())
          set((state) => ({ busy: { ...state.busy, [fileId]: false } }));
      }
    },
  };
});
useWorkspace.subscribe((state, previous) => {
  if (state.accountId !== previous.accountId || state.mode !== previous.mode)
    useComments.getState().reset();
});
