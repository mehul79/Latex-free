"use client";
import { create } from "zustand";
import type {
  ProjectMember,
  FileRevision,
  FileRevisionMetadata,
} from "@latex-free/shared";
import { api } from "@/lib/api";
import { useWorkspace } from "@/stores/workspace";

type RevisionPage = {
  revisions: FileRevisionMetadata[];
  nextCursor: string | null;
};
type MemberRole = "EDITOR" | "VIEWER";
type ProjectDetails = {
  members: Record<string, ProjectMember[]>;
  revisions: Record<string, RevisionPage>;
  details: Record<string, FileRevision>;
  loading: Record<string, boolean>;
  errors: Record<string, string>;
  loadMembers: (pid: string) => Promise<void>;
  addMember: (pid: string, email: string, role: MemberRole) => Promise<void>;
  changeRole: (pid: string, uid: string, role: MemberRole) => Promise<void>;
  removeMember: (pid: string, uid: string) => Promise<void>;
  loadRevisions: (pid: string, fid: string, more?: boolean) => Promise<void>;
  loadRevision: (pid: string, fid: string, rid: string) => Promise<void>;
  reset: () => void;
};
const empty = () => ({
  members: {},
  revisions: {},
  details: {},
  loading: {},
  errors: {},
});
let generation = 0;
const requests = new Map<string, number>();
export const useProjectDetails = create<ProjectDetails>((set, get) => {
  async function request<T>(
    key: string,
    task: () => Promise<T>,
    apply: (data: T) => void,
  ) {
    if (useWorkspace.getState().mode !== "account")
      throw new Error("Sign in to use account project details.");
    const epoch = generation;
    const serial = (requests.get(key) ?? 0) + 1;
    requests.set(key, serial);
    const valid = () => epoch === generation && requests.get(key) === serial;
    set((s) => ({
      loading: { ...s.loading, [key]: true },
      errors: { ...s.errors, [key]: "" },
    }));
    try {
      const data = await task();
      if (valid()) apply(data);
    } catch (error) {
      if (valid())
        set((s) => ({
          errors: { ...s.errors, [key]: (error as Error).message },
        }));
      throw error;
    } finally {
      if (valid()) set((s) => ({ loading: { ...s.loading, [key]: false } }));
    }
  }
  async function mutate(
    pid: string,
    uid: string | null,
    method: string,
    body?: unknown,
  ) {
    await request(
      `members:${pid}`,
      () =>
        api<{ member: ProjectMember }>(
          `/projects/${pid}/members${uid ? `/${uid}` : ""}`,
          {
            method,
            ...(body ? { body: JSON.stringify(body) } : {}),
          },
        ),
      (data) => {
        set((s) => ({
          members: {
            ...s.members,
            [pid]:
              method === "DELETE"
                ? (s.members[pid] ?? []).filter((m) => m.userId !== uid)
                : [
                    ...(s.members[pid] ?? []).filter(
                      (m) => m.userId !== data.member.userId,
                    ),
                    data.member,
                  ],
          },
        }));
      },
    );
  }
  return {
    ...empty(),
    reset: () => {
      generation++;
      requests.clear();
      set(empty());
    },
    loadMembers: (pid) =>
      request(
        `members:${pid}`,
        () => api<{ members: ProjectMember[] }>(`/projects/${pid}/members`),
        ({ members }) =>
          set((s) => ({ members: { ...s.members, [pid]: members } })),
      ),
    addMember: (pid, email, role) => mutate(pid, null, "POST", { email, role }),
    changeRole: (pid, uid, role) => mutate(pid, uid, "PATCH", { role }),
    removeMember: (pid, uid) => mutate(pid, uid, "DELETE"),
    loadRevisions: (pid, fid, more = false) => {
      const cursor = more ? get().revisions[fid]?.nextCursor : null;
      if (more && !cursor) return Promise.resolve();
      return request(
        `revisions:${fid}`,
        () =>
          api<RevisionPage>(
            `/projects/${pid}/files/${fid}/revisions?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          ),
        (page) =>
          set((s) => ({
            revisions: {
              ...s.revisions,
              [fid]: {
                ...page,
                revisions: more
                  ? [
                      ...(s.revisions[fid]?.revisions ?? []),
                      ...page.revisions,
                    ].filter(
                      (r, index, all) =>
                        all.findIndex((other) => other.id === r.id) === index,
                    )
                  : page.revisions,
              },
            },
          })),
      );
    },
    loadRevision: (pid, fid, rid) =>
      request(
        `revision:${rid}`,
        () =>
          api<{ revision: FileRevision }>(
            `/projects/${pid}/files/${fid}/revisions/${rid}`,
          ),
        ({ revision }) =>
          set((s) => ({ details: { ...s.details, [rid]: revision } })),
      ),
  };
});
useWorkspace.subscribe((state, previous) => {
  if (state.accountId !== previous.accountId || state.mode !== previous.mode)
    useProjectDetails.getState().reset();
});
