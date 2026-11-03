"use client";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { API_URL } from "./api";

export type CollaborationState = {
  connected: boolean;
  synchronized: boolean;
  ready: boolean;
  dirty: boolean;
  durable: boolean;
  saving: boolean;
  readOnly: boolean;
  blocked: boolean;
  error: string | null;
  version: number | null;
  peers: number;
};
type Callbacks = {
  project: (content: string, state: CollaborationState) => void;
  reload: (reason: string) => void;
};
export class CollaborationSession {
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText("source");
  readonly undoManager = new Y.UndoManager(this.text);
  readonly provider: HocuspocusProvider;
  private listeners = new Set<() => void>();
  private readonly offline = () => {
    this.provider.disconnect();
    this.patch({ connected: false, synchronized: false });
    this.fail("You’re offline. Your draft is preserved until you reconnect.");
  };
  private readonly online = () => this.provider.connect();
  private callbacks: Callbacks;
  private sequence = 0;
  private revision = 0;
  private identity = "";
  private timer?: ReturnType<typeof setTimeout>;
  private barriers = new Map<
    number,
    {
      revision: number;
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private state: CollaborationState = {
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
  constructor(
    readonly accountId: string,
    readonly projectId: string,
    readonly fileId: string,
    callbacks: Callbacks,
  ) {
    this.callbacks = callbacks;
    const url = new URL(API_URL, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/$/, "")}/api/collaboration`;
    this.provider = new HocuspocusProvider({
      url: url.toString(),
      name: `${projectId}:${fileId}`,
      document: this.doc,
      onStatus: ({ status }) => {
        this.patch({
          connected: status === "connected",
          ...(status !== "connected" ? { synchronized: false } : {}),
        });
      },
      onSynced: ({ state }) => {
        if (!state) return;
        this.patch({ synchronized: true, ready: true });
        void this.save().catch(() => {});
      },
      onClose: ({ event }) => {
        this.patch({ connected: false, synchronized: false });
        if ([1011, 4400, 4403, 4404].includes(event.code))
          this.patch({ blocked: true });
        this.fail(
          "Connection lost. Your draft is preserved until you reconnect.",
        );
      },
      onAuthenticationFailed: ({ reason }) => {
        this.patch({ readOnly: true, blocked: true });
        this.fail(reason || "Your access to this document changed.");
      },
      onStateless: ({ payload }) => this.message(payload),
      onAwarenessChange: ({ states }) => this.patch({ peers: states.length }),
    });
    window.addEventListener("offline", this.offline);
    window.addEventListener("online", this.online);
    if (navigator.onLine === false) this.offline();
    this.doc.on("update", (_update, origin) => {
      if (origin !== this.provider) {
        this.revision++;
        this.patch({ dirty: true, durable: false });
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.save().catch(() => {}), 300);
      } else this.publish();
    });
  }
  readonly snapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  attach(callbacks: Callbacks) {
    window.addEventListener("offline", this.offline);
    window.addEventListener("online", this.online);
    this.callbacks = callbacks;
    this.publish();
    if (navigator.onLine !== false) this.provider.connect();
  }
  private publish() {
    this.callbacks.project(this.text.toString(), this.state);
    this.listeners.forEach((listener) => listener());
  }
  private patch(update: Partial<CollaborationState>) {
    this.state = { ...this.state, ...update };
    this.publish();
  }
  private fail(message: string) {
    for (const request of this.barriers.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    this.barriers.clear();
    this.patch({ saving: false, error: message });
  }
  private message(payload: string) {
    let message: {
      type?: string;
      sequence?: number;
      version?: number;
      reason?: string;
      role?: string;
      user?: { id: string; name: string };
    };
    try {
      message = JSON.parse(payload);
    } catch {
      return;
    }
    if (message.type === "identity") {
      this.patch({
        readOnly: message.role === "VIEWER",
        version: message.version ?? null,
        error: null,
      });
      if (
        message.user &&
        this.identity !== `${message.user.id}:${message.user.name}`
      ) {
        this.identity = `${message.user.id}:${message.user.name}`;
        this.provider.awareness?.setLocalStateField("user", {
          name: message.user.name,
          color: "#2769b3",
          colorLight: "#2769b330",
        });
      }
    } else if (
      message.type === "persisted" &&
      Number.isSafeInteger(message.version)
    ) {
      const request = this.barriers.get(message.sequence!);
      if (!request) return;
      clearTimeout(request.timer);
      this.barriers.delete(message.sequence!);
      this.patch({
        version: Math.max(message.version!, this.state.version ?? 0),
        dirty: request.revision !== this.revision,
        durable: request.revision === this.revision,
        saving: this.barriers.size > 0,
        error: null,
        blocked: false,
      });
      request.resolve();
    } else if (
      message.type === "document-status" &&
      Number.isSafeInteger(message.version)
    ) {
      this.patch({
        version: Math.max(message.version!, this.state.version ?? 0),
      });
    } else if (message.type === "persistence-error") {
      this.patch({ blocked: true });
      this.fail(
        "Could not persist this document. Your draft is preserved; retry save before editing.",
      );
    } else if (message.type === "reload-required") {
      this.patch({ readOnly: true, blocked: true });
      this.fail(
        `Document changed (${message.reason ?? "access"}). Your draft is preserved.`,
      );
      this.callbacks.reload(message.reason ?? "membership");
    }
  }
  save(): Promise<void> {
    if (!this.state.connected || !this.state.synchronized)
      return Promise.reject(
        new Error(
          "Reconnect and synchronize before saving. Your draft is preserved.",
        ),
      );
    const sequence = ++this.sequence;
    this.patch({ saving: true });
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.barriers.delete(sequence);
        this.patch({
          saving: this.barriers.size > 0,
          blocked: true,
          error:
            "Save was not acknowledged. Your draft is preserved; retry save.",
        });
        reject(new Error("Save was not acknowledged. Retry save."));
      }, 15000);
      this.barriers.set(sequence, {
        revision: this.revision,
        resolve,
        reject,
        timer,
      });
      this.provider.flushPendingUpdates();
      this.provider.sendStateless(
        JSON.stringify({ type: "persistence-barrier", sequence }),
      );
    });
  }
  retry() {
    this.provider.connect();
    if (this.state.connected && this.state.synchronized) return this.save();
    return Promise.reject(
      new Error("Reconnecting. Retry save once synchronized."),
    );
  }
  detach() {
    window.removeEventListener("offline", this.offline);
    window.removeEventListener("online", this.online);
    this.provider.disconnect();
  }
  destroy() {
    this.detach();
    clearTimeout(this.timer);
    this.fail("Document session closed.");
    this.provider.destroy();
    this.undoManager.destroy();
    this.doc.destroy();
  }
}
const sessions = new Map<string, CollaborationSession>();
const registryListeners = new Set<() => void>();
export const subscribeCollaborations = (listener: () => void) => {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
};
const key = (account: string, project: string, file: string) =>
  `${account}:${project}:${file}`;
export function getCollaboration(
  account: string,
  project: string,
  file: string,
) {
  return sessions.get(key(account, project, file));
}
export function openCollaboration(
  account: string,
  project: string,
  file: string,
  callbacks: Callbacks,
) {
  const id = key(account, project, file);
  let session = sessions.get(id);
  if (!session) {
    session = new CollaborationSession(account, project, file, callbacks);
    sessions.set(id, session);
    registryListeners.forEach((listener) => listener());
  } else session.attach(callbacks);
  return session;
}
export function closeCleanCollaborations(account?: string) {
  for (const [id, session] of sessions) {
    if (!account || session.accountId !== account) {
      if (session.snapshot().dirty || session.snapshot().saving)
        session.detach();
      else {
        session.destroy();
        sessions.delete(id);
        registryListeners.forEach((listener) => listener());
      }
    }
  }
}

/** Evict a deleted document after its draft has been copied to workspace recovery. */
export function evictCollaboration(
  account: string,
  project: string,
  file: string,
) {
  const id = key(account, project, file);
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  session.destroy();
  registryListeners.forEach((listener) => listener());
}
