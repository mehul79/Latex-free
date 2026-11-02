"use client";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  openCollaboration,
  getCollaboration,
  subscribeCollaborations,
  type CollaborationState,
} from "@/lib/collaboration";
import { useWorkspace } from "@/stores/workspace";
const initial: CollaborationState = {
  connected: false,
  synchronized: false,
  ready: false,
  dirty: false,
  durable: false,
  saving: false,
  readOnly: true,
  blocked: false,
  error: null,
  version: null,
  peers: 0,
};
const idleSubscribe = () => () => {};
const idleSnapshot = () => initial;
export function useCollaboration(
  accountId: string | null,
  projectId: string,
  fileId?: string,
) {
  const lookup = useCallback(
    () =>
      accountId && fileId
        ? (getCollaboration(accountId, projectId, fileId) ?? null)
        : null,
    [accountId, projectId, fileId],
  );
  const session = useSyncExternalStore(
    subscribeCollaborations,
    lookup,
    () => null,
  );
  useEffect(() => {
    if (!accountId || !fileId) return;
    openCollaboration(accountId, projectId, fileId, {
      project: (content, state) => {
        const workspace = useWorkspace.getState();
        if (workspace.accountId === accountId && workspace.mode === "account")
          workspace.projectCollaboration(projectId, fileId, content, state);
      },
      reload: () => {
        const workspace = useWorkspace.getState();
        if (workspace.accountId === accountId)
          void workspace.refreshCollaborationProject(projectId).catch(() => {});
      },
    });
    // Keep cached documents alive across file navigation, including pending acknowledgements.
  }, [accountId, projectId, fileId]);
  const state = useSyncExternalStore(
    session?.subscribe ?? idleSubscribe,
    session?.snapshot ?? idleSnapshot,
    idleSnapshot,
  );
  return { session, state };
}
