"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Check, FilePlus2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  templates,
  createProjectSchema,
  type TemplateId,
} from "@latex-free/shared";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
export function ProjectDialog({
  open,
  onOpenChange,
  initialTemplate = "blank",
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  initialTemplate?: TemplateId;
}) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<TemplateId>(initialTemplate);
  const [busy, setBusy] = useState(false);
  const create = useWorkspace((s) => s.createProject);
  const mode = useWorkspace((s) => s.mode);
  const router = useRouter();
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const input = createProjectSchema.safeParse({ name, template });
    if (!input.success) {
      toast.error("Give your project a name (up to 100 characters).");
      return;
    }
    setBusy(true);
    try {
      const id = await create(input.data.name, template);
      onOpenChange(false);
      router.push(`/projects/${id}`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogContent className="sm:max-w-[540px]">
        <DialogHeader>
          <span className="dialog-icon">
            <FilePlus2 size={22} />
          </span>
          <DialogTitle className="font-display text-3xl font-normal">
            Make room for an idea.
          </DialogTitle>
          <DialogDescription>
            Choose a starting point. You can make it your own from here.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-2">
            <label htmlFor="project-name" className="text-sm font-medium">
              Project name
            </label>
            <Input
              id="project-name"
              autoFocus
              placeholder="e.g. My next great paper"
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">
              Start with a template
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {templates.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => setTemplate(item.id)}
                  className={cn(
                    "template-choice",
                    template === item.id && "selected",
                  )}
                >
                  <span>{item.name}</span>
                  {template === item.id && <Check size={15} />}
                </button>
              ))}
            </div>
          </fieldset>
          <p className="text-xs text-muted-foreground">
            {mode === "local"
              ? "This project will be saved in this browser’s local workspace."
              : "This project will be saved securely to your account."}
          </p>
          <Button disabled={busy} className="w-full" type="submit">
            {busy ? (
              <Loader2 className="animate-spin" />
            ) : (
              <>
                Create project <ArrowUpRight />
              </>
            )}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
