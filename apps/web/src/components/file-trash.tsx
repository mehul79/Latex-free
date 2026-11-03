"use client";
import { useEffect, useState } from "react";
import type { Project } from "@latex-free/shared";
import { Trash2 } from "lucide-react";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function FileTrash({ project }: { project: Project }) {
  const workspace = useWorkspace();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [paths, setPaths] = useState<Record<string, string>>({});
  const local = workspace.mode === "local";
  const files =
    (local ? workspace.localTrash : workspace.accountTrash)[project.id] ?? [];
  const canPurge = local || project.role === "OWNER";
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Trash could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!open) return;
    void useWorkspace
      .getState()
      .loadTrash(project.id)
      .catch((reason) => setError((reason as Error).message));
  }, [open, project.id, workspace.accountId, workspace.mode]);
  if (!local && project.role === "VIEWER") return null;
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="File Trash"
        onClick={() => {
          setPaths({});
          setError("");
          setOpen(true);
        }}
      >
        <Trash2 size={15} />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>File Trash</DialogTitle>
            <DialogDescription>
              Files stay here until explicitly deleted forever and still count
              toward project storage limits. Restoring preserves file identity
              {local
                ? " and binary assets"
                : ", history, comments and collaboration state"}
              .{" "}
              {canPurge
                ? "Permanent deletion cannot be undone."
                : "Only the project owner can permanently delete files."}
            </DialogDescription>
          </DialogHeader>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void run(() => workspace.loadTrash(project.id))}
          >
            Refresh Trash
          </Button>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {!files.length && (
            <p className="text-sm text-muted-foreground">Trash is empty.</p>
          )}
          <ul className="space-y-4">
            {files.map((file) => (
              <li key={file.id} className="space-y-2 rounded-md border p-3">
                <p className="break-all text-sm font-medium">{file.path}</p>
                <p className="text-xs text-muted-foreground">
                  Deleted {new Date(file.deletedAt).toLocaleString()} ·{" "}
                  {file.encoding === "base64" ? "Binary asset" : "Text file"}
                </p>
                <label className="block text-xs">
                  Restore path for {file.path}
                  <input
                    aria-label={`Restore path for ${file.path}`}
                    className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                    placeholder={file.path}
                    value={paths[file.id] ?? ""}
                    onChange={(event) =>
                      setPaths((current) => ({
                        ...current,
                        [file.id]: event.target.value,
                      }))
                    }
                    disabled={busy}
                  />
                </label>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        workspace.restoreTrashedFile(
                          project.id,
                          file.id,
                          file.version,
                          paths[file.id],
                        ),
                      )
                    }
                  >
                    Restore {file.path}
                  </Button>
                  {canPurge && (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Permanently delete “${file.path}”? Its content, saved history and comments will be lost. This cannot be undone.`,
                          )
                        )
                          void run(() =>
                            workspace.purgeTrashedFile(
                              project.id,
                              file.id,
                              file.version,
                            ),
                          );
                      }}
                    >
                      Delete forever {file.path}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
