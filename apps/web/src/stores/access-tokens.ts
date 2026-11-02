"use client";
import { create } from "zustand";
import { api } from "@/lib/api";
import { useWorkspace } from "@/stores/workspace";

export const tokenScopes = [
  "projects:read",
  "files:read",
  "files:write",
  "compile",
  "projects:share",
] as const;
export type TokenScope = (typeof tokenScopes)[number];
export type TokenMetadata = {
  id: string;
  userId: string;
  label: string;
  scopes: TokenScope[];
  projectIds: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};
export type NewToken = {
  label: string;
  scopes: TokenScope[];
  projectIds: string[];
  expiresInDays: number;
};
// Select fields explicitly: even an unexpected server field must never cache a secret.
const metadataOnly = (value: TokenMetadata): TokenMetadata => ({
  id: value.id,
  userId: value.userId,
  label: value.label,
  scopes: [...value.scopes],
  projectIds: [...value.projectIds],
  createdAt: value.createdAt,
  expiresAt: value.expiresAt,
  revokedAt: value.revokedAt,
});
type TokensState = {
  tokens: TokenMetadata[];
  loading: boolean;
  busy: boolean;
  error: string;
  reset: () => void;
  load: () => Promise<void>;
  createToken: (input: NewToken) => Promise<string | undefined>;
  revoke: (id: string) => Promise<void>;
};
let generation = 0;
let listRequest = 0;
const empty = () => ({
  tokens: [] as TokenMetadata[],
  loading: false,
  busy: false,
  error: "",
});
export const useAccessTokens = create<TokensState>((set, get) => {
  function account() {
    const workspace = useWorkspace.getState();
    if (workspace.mode !== "account" || !workspace.accountId)
      throw new Error("Sign in to manage access tokens.");
    const epoch = generation,
      id = workspace.accountId;
    return () =>
      generation === epoch &&
      useWorkspace.getState().accountId === id &&
      useWorkspace.getState().mode === "account";
  }
  return {
    ...empty(),
    reset: () => {
      generation++;
      listRequest++;
      set(empty());
    },
    load: async () => {
      const valid = account(),
        serial = ++listRequest;
      set({ loading: true, error: "" });
      try {
        const result = await api<{ tokens: TokenMetadata[] }>("/tokens");
        if (valid() && serial === listRequest)
          set({ tokens: result.tokens.map(metadataOnly) });
      } catch (error) {
        if (valid() && serial === listRequest)
          set({ error: (error as Error).message });
      } finally {
        if (valid() && serial === listRequest) set({ loading: false });
      }
    },
    createToken: async (input) => {
      const valid = account();
      if (get().busy) throw new Error("A token change is already in progress.");
      set({ busy: true, error: "" });
      try {
        const result = await api<{ token: string; metadata: TokenMetadata }>(
          "/tokens",
          { method: "POST", body: JSON.stringify(input) },
        );
        if (!valid()) return undefined;
        listRequest++;
        set((state) => ({
          tokens: [
            metadataOnly(result.metadata),
            ...state.tokens.filter((item) => item.id !== result.metadata.id),
          ],
          loading: false,
        }));
        return result.token;
      } catch (error) {
        if (valid()) set({ error: (error as Error).message });
        throw error;
      } finally {
        if (valid()) set({ busy: false });
      }
    },
    revoke: async (id) => {
      const valid = account();
      if (get().busy) throw new Error("A token change is already in progress.");
      set({ busy: true, error: "" });
      try {
        await api(`/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!valid()) return;
        listRequest++;
        set((state) => ({
          tokens: state.tokens.map((item) =>
            item.id === id
              ? { ...item, revokedAt: new Date().toISOString() }
              : item,
          ),
          loading: false,
        }));
      } catch (error) {
        if (valid()) set({ error: (error as Error).message });
        throw error;
      } finally {
        if (valid()) set({ busy: false });
      }
    },
  };
});
useWorkspace.subscribe((state, previous) => {
  if (state.accountId !== previous.accountId || state.mode !== previous.mode)
    useAccessTokens.getState().reset();
});
