"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { StreamLanguage } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  Code2,
  Download,
  FilePlus2,
  FileText,
  FolderOpen,
  HardDrive,
  LayoutPanelLeft,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Save,
  Sparkles,
  WrapText,
} from "lucide-react";
import { toast } from "sonner";
import { createFileSchema } from "@latex-free/shared";
import { useWorkspace } from "@/stores/workspace";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), {
  ssr: false,
  loading: () => (
    <div className="p-6">
      <Skeleton className="h-80" />
    </div>
  ),
});
function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function EditorWorkspace({ projectId }: { projectId: string }) {
  const s = useWorkspace();
  const project = s.projects.find((p) => p.id === projectId);
  const [selected, setSelected] = useState<string | null>(null);
  const file =
    project?.files.find((f) => f.id === selected) ?? project?.files[0];
  const [newFile, setNewFile] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [layout, setLayout] = useState<"source" | "split">("split");
  const [wrap, setWrap] = useState(true);
  const [compilerInfo, setCompilerInfo] = useState(false);
  const hasDirty = Boolean(project?.files.some((f) => s.dirty[f.id]));
  const outline = useMemo(
    () =>
      file?.content.split("\n").flatMap((line, i) => {
        const match = line.match(
          /\\(chapter|section|subsection)\*?\{([^}]+)\}/,
        );
        return match
          ? [{ title: match[2], line: i + 1, sub: match[1] === "subsection" }]
          : [];
      }) ?? [],
    [file?.content],
  );
  const save = useCallback(async () => {
    if (!project) return;
    try {
      for (const f of project.files) await s.saveFile(projectId, f.id);
      toast.success(
        s.mode === "local" ? "Saved in this browser" : "Project saved",
      );
    } catch (error) {
      toast.error((error as Error).message);
    }
  }, [project, projectId, s]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    };
    const unload = (e: BeforeUnloadEvent) => {
      if (hasDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("keydown", handler);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("beforeunload", unload);
    };
  }, [save, hasDirty]);
  async function addFile(e: React.FormEvent) {
    e.preventDefault();
    const input = createFileSchema.safeParse({ path });
    if (!input.success) {
      toast.error(
        "Use a relative file path, such as sections/introduction.tex.",
      );
      return;
    }
    setBusy(true);
    try {
      const id = await s.addFile(projectId, input.data.path);
      setSelected(id);
      setNewFile(false);
      setPath("");
      toast.success("File created");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!s.hydrated || s.loading)
    return (
      <main className="p-8">
        <Skeleton className="h-12 mb-4" />
        <Skeleton className="h-[75vh]" />
      </main>
    );
  if (!project)
    return (
      <main className="not-found-workspace">
        <FolderOpen size={40} />
        <h1>
          {s.error
            ? "Workspace unavailable"
            : "This project isn’t in your workspace."}
        </h1>
        <p>
          {s.error ??
            "It may belong to another account or another browser’s local workspace."}
        </p>
        <Button asChild variant="outline">
          <Link href="/">
            Back to projects <ArrowLeft />
          </Link>
        </Button>
      </main>
    );
  return (
    <div className="editor-shell">
      <header className="editor-header">
        <div className="editor-title">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="ghost" size="icon-sm">
                <Link
                  href="/"
                  aria-label="Back to projects"
                  onClick={(e) => {
                    if (
                      hasDirty &&
                      !window.confirm(
                        "You have unsaved changes. Leave without saving them to your account?",
                      )
                    )
                      e.preventDefault();
                  }}
                >
                  <ArrowLeft size={18} />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Back to projects</TooltipContent>
          </Tooltip>
          <span className="editor-brand">ℓf</span>
          <span className="breadcrumb-slash">/</span>
          <h1 title={project.name}>{project.name}</h1>
          <span className="editor-local-label">
            {s.mode === "local" ? "Local" : "Account"}
          </span>
        </div>
        <div className="editor-header-actions">
          <span className="save-status">
            {hasDirty ? (
              "Unsaved changes"
            ) : (
              <>
                <Check size={13} />
                {s.mode === "local" ? "Saved locally" : "Saved"}
              </>
            )}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void save()}
            disabled={Object.values(s.saving).some(Boolean)}
          >
            <Save />
            Save
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Download /> Export <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={!file}
                onSelect={() =>
                  file &&
                  download(
                    file.path.split("/").pop()!,
                    file.content,
                    "text/plain;charset=utf-8",
                  )
                }
              >
                <FileText />
                Download current file
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  download(
                    `${project.name.replace(/[^a-z0-9_-]/gi, "-")}.json`,
                    JSON.stringify(project, null, 2),
                    "application/json",
                  )
                }
              >
                <Download />
                Download project backup (JSON)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <div className="editor-body">
        {sidebar && (
          <aside className="file-sidebar">
            <div className="files-heading">
              <span>PROJECT FILES</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Add file"
                    onClick={() => setNewFile(true)}
                  >
                    <FilePlus2 size={16} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Add a file</TooltipContent>
              </Tooltip>
            </div>
            <div className="file-root">
              <ChevronDown size={13} />
              <FolderOpen size={15} />
              <span>{project.name}</span>
            </div>
            <nav aria-label="Project files" className="file-nav">
              {project.files.map((item) => (
                <button
                  key={item.id}
                  className={cn("file-item", file?.id === item.id && "active")}
                  onClick={() => setSelected(item.id)}
                >
                  <FileText size={14} />
                  <span title={item.path}>{item.path}</span>
                  {s.dirty[item.id] && (
                    <span className="dirty-dot" aria-label="Unsaved" />
                  )}
                </button>
              ))}
            </nav>
            <div className="outline-heading">DOCUMENT OUTLINE</div>
            {outline.length ? (
              <ul className="document-outline">
                {outline.map((item) => (
                  <li key={item.line} className={cn(item.sub && "outline-sub")}>
                    <span>{item.title}</span>
                    <small>{item.line}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="outline-empty">
                Sections will appear here as you write.
              </p>
            )}
            <div className="file-sidebar-footer">
              <LeafIcon />
              <span>
                A little space.
                <br />
                An open possibility.
              </span>
            </div>
          </aside>
        )}
        <section
          className={cn("source-pane", layout === "source" && "source-full")}
          aria-label="Source editor"
        >
          <div className="editor-pane-toolbar">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={sidebar ? "Hide file tree" : "Show file tree"}
                onClick={() => setSidebar(!sidebar)}
              >
                {sidebar ? (
                  <PanelLeftClose size={15} />
                ) : (
                  <PanelLeftOpen size={15} />
                )}
              </Button>
              <span className="active-file-tab">
                <FileText size={13} />
                {file?.path ?? "No file selected"}
              </span>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Toggle line wrapping"
                  aria-pressed={wrap}
                  onClick={() => setWrap(!wrap)}
                >
                  <WrapText size={15} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Line wrapping</TooltipContent>
            </Tooltip>
          </div>
          <div className="code-surface">
            {file && (
              <CodeMirror
                key={file.id}
                value={file.content}
                height="100%"
                theme="light"
                extensions={[
                  ...(file.path.endsWith(".tex")
                    ? [StreamLanguage.define(stex)]
                    : []),
                  ...(wrap ? [EditorView.lineWrapping] : []),
                ]}
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: true,
                  highlightActiveLine: true,
                  autocompletion: true,
                }}
                onChange={(value) => s.editFile(projectId, file.id, value)}
                className={cn("latex-code-editor", wrap && "wrap-code")}
                aria-label={`Source for ${file.path}`}
              />
            )}
          </div>
          <div className="source-status">
            <span>
              <Code2 size={12} />
              {file?.path.endsWith(".tex") ? "LaTeX" : "Plain text"}
            </span>
            <span>
              {file?.content.split("\n").length ?? 0} lines ·{" "}
              {file?.content.length ?? 0} characters
            </span>
          </div>
        </section>
        {layout === "split" && (
          <section className="preview-pane" aria-label="PDF preview">
            <div className="editor-pane-toolbar">
              <span className="preview-label">
                <FileText size={14} /> PDF preview
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCompilerInfo(true)}
              >
                <CircleHelp size={14} /> Compiler setup
              </Button>
            </div>
            <div className="preview-empty">
              <div className="preview-sheet">
                <div className="preview-sheet-icon">
                  <FileText size={30} strokeWidth={1.2} />
                </div>
                <span className="eyebrow">FROM SOURCE TO SOMETHING</span>
                <h2>
                  Your words,
                  <br />
                  <em>beautifully set.</em>
                </h2>
                <p>
                  Your compiled PDF will appear here once the LaTeX compiler is
                  connected.
                </p>
                <span className="preview-sheet-rule" />
                <small>For now, make yourself at home in the editor.</small>
              </div>
              <p className="preview-footnote">
                No PDF has been generated for this project.
              </p>
            </div>
          </section>
        )}
      </div>
      <footer className="editor-footer">
        <span>
          <span className="status-dot" />
          {s.mode === "local" ? (
            <>
              <HardDrive size={12} /> Local workspace · saved in this browser
            </>
          ) : (
            "Account workspace · save changes with ⌘/Ctrl S"
          )}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setLayout(layout === "split" ? "source" : "split")}
        >
          <LayoutPanelLeft size={13} />
          {layout === "split" ? "Source only" : "Show preview"}
        </Button>
      </footer>
      <Dialog open={newFile} onOpenChange={setNewFile}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a file</DialogTitle>
            <DialogDescription>
              Create a text file in your project. Use folders in its path to
              keep things organized.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={addFile} className="space-y-4">
            <label htmlFor="file-path" className="text-sm font-medium">
              File path
            </label>
            <Input
              id="file-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="sections/introduction.tex"
              autoFocus
              required
              maxLength={240}
            />
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <FilePlus2 />}
              Create file
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={compilerInfo} onOpenChange={setCompilerInfo}>
        <DialogContent>
          <DialogHeader>
            <span className="dialog-icon">
              <Sparkles />
            </span>
            <DialogTitle className="font-display text-3xl font-normal">
              The next chapter: compilation.
            </DialogTitle>
            <DialogDescription>
              The editor is ready for writing. PDF generation will use a
              separate, sandboxed TeX Live worker connected to Express.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Compilation is deferred for this milestone. You can download a .tex
            file and compile it with your own LaTeX installation in the
            meantime.
          </p>
          <Button
            onClick={() => {
              setCompilerInfo(false);
              if (file)
                download(
                  file.path.split("/").pop()!,
                  file.content,
                  "text/plain;charset=utf-8",
                );
            }}
          >
            Download current file <ArrowUpRight />
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
function LeafIcon() {
  return <span className="editor-leaf">✳</span>;
}
