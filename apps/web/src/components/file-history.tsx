"use client";
import { useEffect, useState } from "react";
import { Download, History } from "lucide-react";
import type { ProjectFile } from "@latex-free/shared";
import { useWorkspace } from "@/stores/workspace";
import { useProjectDetails } from "@/stores/project-details";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function FileHistory({
  projectId,
  file,
  readOnly,
}: {
  projectId: string;
  file: ProjectFile;
  readOnly: boolean;
}) {
  const s = useWorkspace();
  const d = useProjectDetails();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState("");
  const [restoring, setRestoring] = useState(false);
  const account = s.mode === "account";
  const key = `revisions:${file.id}`;
  const page = d.revisions[file.id];
  const revision = selected ? d.details[selected] : undefined;
  const blocked =
    s.dirty[file.id] ||
    file.id in s.conflicts ||
    s.pendingRecovery.some((draft) => draft.fileId === file.id);
  const busy = restoring || s.saving[file.id];
  useEffect(() => {
    if (open && account)
      void useProjectDetails
        .getState()
        .loadRevisions(projectId, file.id)
        .catch(() => {});
  }, [open, account, projectId, file.id]);
  if (file.encoding === "base64") return null;
  async function restore() {
    if (!selected || blocked || busy || readOnly) return;
    if (
      !window.confirm(
        `Restore version ${revision?.version} of this file? This creates a new version and keeps the current path (${file.path}).`,
      )
    )
      return;
    setRestoring(true);
    setRestoreError("");
    try {
      await s.restoreRevision(projectId, file.id, selected);
      await d.loadRevisions(projectId, file.id);
    } catch (error) {
      setRestoreError((error as Error).message);
    } finally {
      setRestoring(false);
    }
  }
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setSelected(null);
          setRestoreError("");
          setOpen(true);
        }}
      >
        <History /> History
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>File history · {file.path}</DialogTitle>
            <DialogDescription>
              {account
                ? "Snapshots of saved text versions, including renames. Restoring keeps the current file path. Recover deleted files from File Trash before opening their history."
                : "Sign in and create or import an account project for saved file history. This local project has no account history. Use Export to download local backups."}
            </DialogDescription>
          </DialogHeader>
          {account && (
            <>
              {readOnly && (
                <p className="text-sm text-muted-foreground">
                  Viewer access: preview and download revisions.
                </p>
              )}
              {d.errors[key] && (
                <p role="alert" className="text-sm text-destructive">
                  {d.errors[key]}
                </p>
              )}
              {d.loading[key] && (
                <p role="status" className="text-sm">
                  Loading file history…
                </p>
              )}
              {!d.loading[key] && !d.errors[key] && !page?.revisions.length && (
                <p className="text-sm text-muted-foreground">
                  No saved revisions are available for this file.
                </p>
              )}
              <div className="grid gap-4 sm:grid-cols-[15rem_1fr]">
                <div className="space-y-2">
                  <ul
                    aria-label="Saved revisions"
                    className="max-h-72 space-y-1 overflow-y-auto"
                  >
                    {page?.revisions.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          aria-pressed={selected === item.id}
                          className={`w-full rounded-md border p-3 text-left text-sm ${selected === item.id ? "bg-muted" : ""}`}
                          onClick={() => {
                            setSelected(item.id);
                            setRestoreError("");
                            void d
                              .loadRevision(projectId, file.id, item.id)
                              .catch(() => {});
                          }}
                        >
                          <span className="block font-medium">
                            Version {item.version} ·{" "}
                            {item.reason === "trash"
                              ? "Moved to Trash"
                              : item.reason === "trash-restore"
                                ? "Restored from Trash"
                                : item.reason}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {new Date(item.createdAt).toLocaleString()} ·{" "}
                            {item.author?.name ?? "Unknown author"}
                          </span>
                          <span className="block break-all text-xs text-muted-foreground">
                            {item.path}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {page?.nextCursor && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={d.loading[key]}
                      onClick={() =>
                        void d
                          .loadRevisions(projectId, file.id, true)
                          .catch(() => {})
                      }
                    >
                      Load older revisions
                    </Button>
                  )}
                  {d.errors[key] && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={d.loading[key]}
                      onClick={() =>
                        void d.loadRevisions(projectId, file.id).catch(() => {})
                      }
                    >
                      Retry history
                    </Button>
                  )}
                </div>
                <div className="min-w-0 space-y-3">
                  {!selected && (
                    <p className="text-sm text-muted-foreground">
                      Select a saved version to preview it.
                    </p>
                  )}
                  {selected && d.loading[`revision:${selected}`] && (
                    <p role="status" className="text-sm">
                      Loading snapshot…
                    </p>
                  )}
                  {selected && d.errors[`revision:${selected}`] && (
                    <p role="alert" className="text-sm text-destructive">
                      {d.errors[`revision:${selected}`]}
                    </p>
                  )}
                  {revision && (
                    <>
                      <pre
                        aria-label="Revision preview"
                        className="max-h-72 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap break-words"
                      >
                        {revision.content || "(Empty file)"}
                      </pre>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const url = URL.createObjectURL(
                              new Blob([revision.content], {
                                type: "text/plain;charset=utf-8",
                              }),
                            );
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `${revision.path.split("/").pop()}.v${revision.version}`;
                            a.click();
                            setTimeout(() => URL.revokeObjectURL(url), 1000);
                          }}
                        >
                          <Download /> Download snapshot
                        </Button>
                        {!readOnly && (
                          <Button
                            size="sm"
                            disabled={
                              blocked ||
                              busy ||
                              d.loading[`revision:${selected}`]
                            }
                            onClick={() => void restore()}
                          >
                            {busy ? "Restoring…" : "Restore this version"}
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                  {!readOnly && blocked && (
                    <p className="text-sm text-muted-foreground">
                      Save or resolve your unsaved draft before restoring. Your
                      draft is preserved.
                    </p>
                  )}
                  {restoreError && (
                    <p role="alert" className="text-sm text-destructive">
                      {restoreError}
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
