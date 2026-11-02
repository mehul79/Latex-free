import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CollaborationSession } from "../src/lib/collaboration";
const { providers } = vi.hoisted(() => ({
  providers: [] as {
    configuration: Record<string, (payload: never) => void>;
    sendStateless: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProvider: class {
    sendStateless = vi.fn();
    flushPendingUpdates = vi.fn();
    awareness = { setLocalStateField: vi.fn() };
    connect = vi.fn();
    disconnect = vi.fn();
    destroy = vi.fn();
    constructor(
      public configuration: Record<string, (payload: never) => void>,
    ) {
      providers.push(this);
    }
  },
}));
beforeEach(() => {
  providers.length = 0;
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      location: { href: "http://localhost:3000" },
    }),
  );
  vi.stubGlobal("navigator", { onLine: true });
  vi.useFakeTimers();
});
function setup() {
  const project = vi.fn();
  const session = new CollaborationSession("alice", "project", "file", {
    project,
    reload: vi.fn(),
  });
  const provider = providers[0];
  const event = (name: string, payload: unknown) =>
    provider.configuration[name](payload as never);
  const message = (payload: unknown) =>
    event("onStateless", { payload: JSON.stringify(payload) });
  event("onStatus", { status: "connected" });
  message({
    type: "identity",
    role: "EDITOR",
    user: { id: "alice", name: "Alice" },
    version: 0,
  });
  event("onSynced", { state: true });
  message({ type: "persisted", sequence: 1, version: 0 });
  return { session, provider, event, message, project };
}
describe("collaborative persistence", () => {
  it("disconnects on browser offline, keeps drafts editable, and reconnects online", async () => {
    const { session, event, message } = setup();
    window.dispatchEvent(new Event("offline"));
    expect(session.provider.disconnect).toHaveBeenCalledOnce();
    expect(session.snapshot()).toMatchObject({
      connected: false,
      synchronized: false,
      blocked: false,
      readOnly: false,
    });
    session.text.insert(0, "offline draft");
    await expect(session.save()).rejects.toThrow("Reconnect");
    window.dispatchEvent(new Event("online"));
    expect(session.provider.connect).toHaveBeenCalledOnce();
    event("onStatus", { status: "connected" });
    event("onSynced", { state: true });
    message({ type: "persisted", sequence: 2, version: 1 });
    expect(session.snapshot().durable).toBe(true);
    expect(session.text.toString()).toBe("offline draft");
    session.detach();
    window.dispatchEvent(new Event("online"));
    expect(session.provider.connect).toHaveBeenCalledOnce();
    vi.stubGlobal("navigator", { onLine: false });
    session.attach({ project: vi.fn(), reload: vi.fn() });
    expect(session.provider.connect).toHaveBeenCalledOnce();
    session.destroy();
    window.dispatchEvent(new Event("online"));
    expect(session.provider.connect).toHaveBeenCalledOnce();
  });
  it("requires a matching barrier ack after deletes, regardless of sync or server version status", async () => {
    const { session, event, message } = setup();
    session.text.insert(0, "abcdef");
    const save = session.save();
    message({ type: "document-status", version: 1 });
    event("onSynced", { state: true });
    expect(session.snapshot().dirty).toBe(true);
    message({ type: "persisted", sequence: 2, version: 1 });
    await save;
    session.text.delete(0, 2);
    const deleted = session.save();
    expect(session.snapshot().durable).toBe(false);
    message({ type: "persisted", sequence: 4, version: 2 });
    await deleted;
    expect(session.snapshot().dirty).toBe(false);
    expect(session.snapshot().durable).toBe(true);
    session.destroy();
  });
  it("does not clear edits made after the acknowledged barrier", async () => {
    const { session, message } = setup();
    session.text.insert(0, "First");
    const saving = session.save();
    session.text.insert(5, " second");
    message({ type: "persisted", sequence: 2, version: 1 });
    await saving;
    expect(session.snapshot().dirty).toBe(true);
    session.destroy();
  });
  it("retains the YDoc and rejects pending saves on failure, and locks DB failures", async () => {
    const { session, event, message } = setup();
    session.text.insert(0, "preserved");
    const saving = session.save();
    const rejected = expect(saving).rejects.toThrow("preserved");
    message({ type: "persistence-error", error: "Unavailable" });
    event("onClose", { event: { code: 1011 } });
    await rejected;
    expect(session.text.toString()).toBe("preserved");
    expect(session.snapshot()).toMatchObject({
      dirty: true,
      durable: false,
      blocked: true,
    });
    session.destroy();
  });
  it("projects remote updates without treating them as unsaved local edits", () => {
    const { session, project } = setup();
    const remote = new Y.Doc();
    remote.getText("source").insert(0, "remote");
    Y.applyUpdate(session.doc, Y.encodeStateAsUpdate(remote), session.provider);
    expect(project.mock.calls.at(-1)?.[0]).toBe("remote");
    expect(session.snapshot().dirty).toBe(false);
    session.destroy();
    remote.destroy();
  });
  it("retains offline drafts and only clears them after reconnect persistence proof", async () => {
    const { session, event, message } = setup();
    event("onClose", { event: { code: 1006 } });
    expect(session.snapshot().blocked).toBe(false);
    session.text.insert(0, "offline");
    await expect(session.save()).rejects.toThrow("Reconnect");
    expect(session.snapshot().dirty).toBe(true);
    event("onStatus", { status: "connected" });
    event("onSynced", { state: true });
    expect(session.snapshot().dirty).toBe(true);
    message({ type: "persisted", sequence: 2, version: 1 });
    expect(session.snapshot().durable).toBe(true);
    session.destroy();
  });
  it("locks authentication failures and does not publish awareness again for the same identity", () => {
    const { session, event, message } = setup();
    message({
      type: "identity",
      role: "EDITOR",
      user: { id: "alice", name: "Alice" },
      version: 0,
    });
    expect(
      session.provider.awareness?.setLocalStateField,
    ).toHaveBeenCalledTimes(1);
    event("onAuthenticationFailed", { reason: "Access revoked" });
    expect(session.snapshot()).toMatchObject({
      readOnly: true,
      blocked: true,
      error: "Access revoked",
    });
    session.destroy();
  });
  it("keeps the draft unsaved and blocks further input when the barrier times out", async () => {
    const { session } = setup();
    session.text.insert(0, "unacknowledged");
    const save = session.save();
    const rejected = expect(save).rejects.toThrow("acknowledged");
    await vi.advanceTimersByTimeAsync(15001);
    await rejected;
    expect(session.snapshot()).toMatchObject({
      dirty: true,
      durable: false,
      blocked: true,
    });
    expect(session.text.toString()).toBe("unacknowledged");
    session.destroy();
  });
});
