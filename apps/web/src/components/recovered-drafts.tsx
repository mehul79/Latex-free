"use client";
import { useState } from "react";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
export function RecoveredDrafts({ projectId }: { projectId: string }) {
  const s = useWorkspace();
  const [selected, setSelected] = useState<string | null>(null);
  const [comparison, setComparison] = useState<{
    content: string;
    version: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const project = s.projects.find((p) => p.id === projectId);
  const draft = s.pendingRecovery.find(
    (d) => d.projectId === projectId && d.fileId === selected,
  );
  const file = project?.files.find((f) => f.id === selected);
  return (
    <>
      {s.pendingRecovery
        .filter((d) => d.projectId === projectId)
        .map((d) => {
          const current = project?.files.find((f) => f.id === d.fileId);
          return (
            <Button
              size="sm"
              variant="outline"
              key={d.fileId}
              disabled={!current}
              onClick={() => {
                setSelected(d.fileId);
                setComparison(
                  current
                    ? { content: current.content, version: current.version }
                    : null,
                );
                setError("");
              }}
            >
              Compare {current?.path ?? "deleted file"}
            </Button>
          );
        })}
      <Dialog
        open={!!draft}
        onOpenChange={(open) => {
          if (!open && !busy) setSelected(null);
        }}
      >
        <DialogContent className="sm:max-w-4xl max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Compare recovered draft · {file?.path}</DialogTitle>
            <DialogDescription>
              Review your recovered text against account version{" "}
              {comparison?.version}. Recovering replaces that version through
              the server and creates a saved revision. If the account changes,
              compare again.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3>Account version {comparison?.version}</h3>
              <pre className="text-xs whitespace-pre-wrap border rounded p-3 max-h-96 overflow-auto">
                {comparison?.content}
              </pre>
            </div>
            <div>
              <h3>Recovered draft</h3>
              <pre className="text-xs whitespace-pre-wrap border rounded p-3 max-h-96 overflow-auto">
                {draft?.content}
              </pre>
            </div>
          </div>
          {error && <p role="alert">{error}</p>}
          <Button
            disabled={
              busy ||
              project?.role === "VIEWER" ||
              !file ||
              !comparison ||
              !!s.dirty[file.id]
            }
            onClick={() => {
              if (!draft || !comparison) return;
              setBusy(true);
              setError("");
              void s
                .recoverCollaborationDraft(
                  projectId,
                  draft.fileId,
                  comparison.version,
                )
                .then(() => setSelected(null))
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Recovering…" : "Recover reviewed draft"}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
