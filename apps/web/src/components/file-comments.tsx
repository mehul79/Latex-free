"use client";
import { useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import type { ProjectFile } from "@latex-free/shared";
import { useWorkspace } from "@/stores/workspace";
import {
  useComments,
  type CommentThread,
  type FileComment,
} from "@/stores/comments";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function FileComments({
  projectId,
  file,
  readOnly,
  owner,
}: {
  projectId: string;
  file: ProjectFile;
  readOnly: boolean;
  owner: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const accountId = useWorkspace((state) => state.accountId);
  const account = useWorkspace((state) => state.mode === "account");
  const store = useComments();
  const page = store.pages[file.id];
  const busy = Boolean(store.busy[file.id]);
  useEffect(() => {
    if (!open || !account) return;
    void useComments.getState().load(projectId, file.id);
  }, [open, account, projectId, file.id]);
  if (file.encoding === "base64") return null;
  const change = (
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    data?: unknown,
  ) => store.change(projectId, file.id, path, method, data);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <MessageSquare /> Comments
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Comments · {file.path}</DialogTitle>
            <DialogDescription>
              {account
                ? "Discuss this file with your project members. Refresh to see the latest replies."
                : "Sign in and open an account project to discuss files with collaborators."}
            </DialogDescription>
          </DialogHeader>
          {account && (
            <>
              {readOnly && (
                <p className="text-sm text-muted-foreground">
                  Viewer access: read discussions.
                </p>
              )}
              {store.errors[file.id] && (
                <p role="alert" className="text-sm text-destructive">
                  {store.errors[file.id]}
                </p>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={busy || store.loading[file.id]}
                onClick={() => void store.load(projectId, file.id)}
              >
                Refresh comments
              </Button>
              {store.loading[file.id] && !page && (
                <p role="status">Loading comments…</p>
              )}
              {page?.threads.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No discussions yet.
                </p>
              )}
              {!readOnly && (
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!body.trim() || busy) return;
                    void change("/threads", "POST", { body })
                      .then(() => setBody(""))
                      .catch(() => {});
                  }}
                >
                  <label
                    htmlFor="new-discussion"
                    className="text-sm font-medium"
                  >
                    New discussion
                  </label>
                  <textarea
                    id="new-discussion"
                    maxLength={5000}
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    className="w-full rounded-md border p-3 text-sm"
                    rows={3}
                  />
                  <Button
                    size="sm"
                    disabled={busy || !body.trim()}
                    type="submit"
                  >
                    Post comment
                  </Button>
                </form>
              )}
              <div className="space-y-4" aria-label="File discussions">
                {page?.threads.map((thread) => (
                  <Thread
                    key={thread.id}
                    thread={thread}
                    readOnly={readOnly}
                    owner={owner}
                    accountId={accountId}
                    busy={busy}
                    change={change}
                  />
                ))}
              </div>
              {page?.nextCursor && (
                <Button
                  variant="outline"
                  disabled={busy || store.loading[file.id]}
                  onClick={() => void store.load(projectId, file.id, true)}
                >
                  Load more discussions
                </Button>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
function Thread({
  thread,
  readOnly,
  owner,
  accountId,
  busy,
  change,
}: {
  thread: CommentThread;
  readOnly: boolean;
  owner: boolean;
  accountId: string | null;
  busy: boolean;
  change(
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    data?: unknown,
  ): Promise<void>;
}) {
  const [reply, setReply] = useState("");
  return (
    <article
      className="space-y-3 rounded-lg border p-4"
      aria-label={`Discussion ${thread.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {thread.resolvedAt ? "Resolved" : "Open"} ·{" "}
          {thread.anchorStatus === "file"
            ? "File discussion"
            : thread.anchorStatus === "anchored"
              ? "Selected text"
              : "Selection no longer available"}
        </span>
        {!readOnly && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void change(`/threads/${thread.id}`, "PATCH", {
                resolved: !thread.resolvedAt,
              }).catch(() => {})
            }
          >
            {thread.resolvedAt ? "Reopen discussion" : "Resolve discussion"}
          </Button>
        )}
      </div>
      {thread.comments.map((comment) => (
        <Comment
          key={comment.id}
          comment={comment}
          editable={!readOnly && (owner || comment.authorId === accountId)}
          busy={busy}
          change={change}
        />
      ))}
      {!readOnly && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!reply.trim() || busy) return;
            void change(`/threads/${thread.id}/replies`, "POST", {
              body: reply,
            })
              .then(() => setReply(""))
              .catch(() => {});
          }}
        >
          <label htmlFor={`reply-${thread.id}`} className="text-sm font-medium">
            Reply
          </label>
          <textarea
            id={`reply-${thread.id}`}
            maxLength={5000}
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            className="w-full rounded-md border p-2 text-sm"
            rows={2}
          />
          <Button type="submit" size="sm" disabled={busy || !reply.trim()}>
            Post reply
          </Button>
        </form>
      )}
    </article>
  );
}
function Comment({
  comment,
  editable,
  busy,
  change,
}: {
  comment: FileComment;
  editable: boolean;
  busy: boolean;
  change(
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    data?: unknown,
  ): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  return (
    <div className="space-y-2 border-l-2 pl-3">
      <p className="text-xs text-muted-foreground">
        {comment.author?.name ?? "Former member"}
      </p>
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!body.trim() || busy) return;
            void change(`/comments/${comment.id}`, "PATCH", { body })
              .then(() => setEditing(false))
              .catch(() => {});
          }}
        >
          <label htmlFor={`edit-${comment.id}`} className="text-sm">
            Edit comment
          </label>
          <textarea
            id={`edit-${comment.id}`}
            value={body}
            maxLength={5000}
            onChange={(event) => setBody(event.target.value)}
            className="w-full rounded-md border p-2 text-sm"
          />
          <Button type="submit" size="sm" disabled={busy || !body.trim()}>
            Save comment
          </Button>{" "}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setEditing(false)}
          >
            Cancel edit
          </Button>
        </form>
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm">
          {comment.body}
        </p>
      )}
      {editable && !editing && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setBody(comment.body);
              setEditing(true);
            }}
          >
            Edit comment
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Delete this comment?"))
                void change(`/comments/${comment.id}`, "DELETE").catch(
                  () => {},
                );
            }}
          >
            Delete comment
          </Button>
        </div>
      )}
    </div>
  );
}
