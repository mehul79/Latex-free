"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { importProjectArchive } from "@/lib/archive";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
export function ImportProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const importProject = useWorkspace((s) => s.importProject);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const imported = await importProjectArchive(file);
      const id = await importProject(imported.name, imported.files);
      toast.success("Project imported");
      onOpenChange(false);
      router.push(`/projects/${id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) {
          onOpenChange(v);
          setError("");
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import a project</DialogTitle>
          <DialogDescription>
            Bring a ZIP archive or a Latex-free JSON backup into your workspace.
            Folder paths and assets are preserved.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <label htmlFor="project-archive" className="text-sm font-medium">
            Project archive
          </label>
          <Input
            id="project-archive"
            type="file"
            accept=".zip,.json,application/zip,application/json"
            disabled={busy}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setError("");
            }}
          />
          <p className="text-xs text-muted-foreground">
            Up to 500 files and 20 MiB unpacked. Text files up to 1 MB; assets
            up to 5 MiB.
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button disabled={!file || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Upload />}Import
              project
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
