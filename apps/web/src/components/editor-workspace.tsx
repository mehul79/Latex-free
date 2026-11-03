"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import Image from "next/image";
import { StreamLanguage } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import {
  ArrowLeft,
  Check,
  ChevronDown,
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
  WrapText,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { createFileSchema, type ProjectFile } from "@latex-free/shared";
import { useWorkspace } from "@/stores/workspace";
import { useCollaboration } from "@/hooks/use-collaboration";
import { CollaborativeEditor } from "@/components/collaborative-editor";
import { RecoveredDrafts } from "@/components/recovered-drafts";
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
import { ProjectSharing } from "@/components/project-sharing";
import { FileComments } from "@/components/file-comments";
import { FileTrash } from "@/components/file-trash";
import { FileHistory } from "@/components/file-history";
import { ProjectFiles } from "@/components/project-files";
import { CompilePanel } from "@/components/compile-panel";
import { exportProjectZip, exportProjectJson } from "@/lib/archive";
const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), {
  ssr: false,
  loading: () => (
    <div className="p-6">
      <Skeleton className="h-80" />
    </div>
  ),
});
function download(name: string, content: string | Uint8Array, type: string) {
  const bytes =
    typeof content === "string" ? content : new Uint8Array(content).buffer;
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadFile(file: ProjectFile) {
  const content =
    file.encoding === "base64"
      ? Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0))
      : file.content;
  download(
    file.path.split("/").pop()!,
    content,
    file.mimeType ?? "application/octet-stream",
  );
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
  const [mobilePreview, setMobilePreview] = useState(false);
  const [action, setAction] = useState<{
    file: ProjectFile;
    kind: "rename" | "delete";
  } | null>(null);
  const [actionPath, setActionPath] = useState("");
  const [actionError, setActionError] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const editorView = useRef<EditorView | null>(null);
  const pendingLine = useRef<number | null>(null);
  function jumpToLine(view: EditorView, line: number) {
    const pos = view.state.doc.line(
      Math.max(1, Math.min(line, view.state.doc.lines)),
    ).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  }
  const collaborative =
    s.mode === "account" && !!file && file.encoding !== "base64";
  const collaboration = useCollaboration(
    s.mode === "account" ? s.accountId : null,
    projectId,
    collaborative ? file?.id : undefined,
  );
  const readOnly =
    project?.role === "VIEWER" ||
    Boolean(
      collaborative && collaboration.session && collaboration.state.readOnly,
    );
  const hasConflict =
    file && Object.prototype.hasOwnProperty.call(s.conflicts, file.id);
  const startAutosave = s.startAutosave;
  useEffect(() => startAutosave(), [startAutosave]);
  const hasDirty = Boolean(project?.files.some((f) => s.dirty[f.id]));
  const outline = useMemo(
    () =>
      (file?.encoding === "base64" ? undefined : file?.content)
        ?.split("\n")
        .flatMap((line, i) => {
          const match = line.match(
            /\\(chapter|section|subsection)\*?\{([^}]+)\}/,
          );
          return match
            ? [{ title: match[2], line: i + 1, sub: match[1] === "subsection" }]
            : [];
        }) ?? [],
    [file?.content, file?.encoding],
  );
  const save = useCallback(async () => {
    if (!project || readOnly) return;
    try {
      for (const f of project.files) await s.saveFile(projectId, f.id);
      toast.success(
        s.mode === "local" ? "Saved in this browser" : "Project saved",
      );
    } catch (error) {
      toast.error((error as Error).message);
    }
  }, [project, projectId, s, readOnly]);
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
  async function uploadFiles(files: FileList | null) {
    if (!files || readOnly) return;
    setBusy(true);
    let count = 0;
    try {
      for (const item of Array.from(files)) {
        const text =
          /\.(tex|bib|sty|cls|txt|md|csv|json|yaml|yml|bst|cfg|def|clo|fd|ltx)$/i.test(
            item.name,
          ) || item.type.startsWith("text/");
        if (item.size > (text ? 1_000_000 : 5 * 1024 * 1024))
          throw new Error(
            `${item.name} exceeds the ${text ? "1 MB text" : "5 MiB asset"} limit.`,
          );
        const bytes = new Uint8Array(await item.arrayBuffer());
        let content: string;
        if (text)
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        else {
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          content = btoa(binary);
        }
        const id = await s.addAsset(
          projectId,
          item.name,
          content,
          text ? "utf8" : "base64",
          item.type || null,
        );
        setSelected(id);
        count++;
      }
      toast.success(`${count} ${count === 1 ? "file" : "files"} uploaded`);
    } catch (error) {
      toast.error(
        `${count ? `${count} uploaded. ` : ""}${(error as Error).message}`,
      );
    } finally {
      setBusy(false);
      if (upload.current) upload.current.value = "";
    }
  }
  async function submitFileAction(e: React.FormEvent) {
    e.preventDefault();
    if (!action || readOnly) return;
    setBusy(true);
    setActionError("");
    try {
      if (action.kind === "delete")
        await s.deleteFile(projectId, action.file.id);
      else await s.renameFile(projectId, action.file.id, actionPath);
      toast.success(
        action.kind === "delete" ? "File moved to Trash" : "File moved",
      );
      setAction(null);
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function addFile(e: React.FormEvent) {
    e.preventDefault();
    if (readOnly) return;
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
    <div className={cn("editor-shell", mobilePreview && "mobile-preview-on")}>
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
            {s.mode === "local"
              ? "Local"
              : project.role === "VIEWER"
                ? "Viewer"
                : project.role === "EDITOR"
                  ? "Editor"
                  : "Owner"}
          </span>
        </div>
        <div className="editor-header-actions">
          <ProjectSharing
            key={`${s.accountId}:${project.id}`}
            project={project}
          />
          {file && (
            <FileHistory
              key={`${s.accountId}:${file.id}`}
              projectId={project.id}
              file={file}
              readOnly={readOnly}
            />
          )}
          {file && (
            <FileComments
              key={`comments:${s.accountId}:${file.id}`}
              projectId={project.id}
              file={file}
              readOnly={readOnly}
              owner={project.role === "OWNER"}
            />
          )}
          <span className="save-status" aria-live="polite">
            {collaborative &&
            (!collaboration.state.connected ||
              !collaboration.state.synchronized ||
              !collaboration.state.durable) ? (
              !collaboration.state.connected ? (
                "Offline · draft retained"
              ) : !collaboration.state.synchronized ? (
                "Connected · synchronizing…"
              ) : collaboration.state.saving ? (
                "Synchronized · saving…"
              ) : (
                "Synchronized · changes pending"
              )
            ) : hasDirty ? (
              Object.values(s.saving).some(Boolean) ? (
                "Saving…"
              ) : (
                "Changes pending"
              )
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
            disabled={readOnly || Object.values(s.saving).some(Boolean)}
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
                onSelect={() => file && downloadFile(file)}
              >
                <FileText />
                Download current file
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  try {
                    download(
                      `${project.name.replace(/[^a-z0-9_-]/gi, "-")}.zip`,
                      exportProjectZip(project),
                      "application/zip",
                    );
                  } catch (error) {
                    toast.error((error as Error).message);
                  }
                }}
              >
                <Download />
                Download project (ZIP)
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  download(
                    `${project.name.replace(/[^a-z0-9_-]/gi, "-")}.json`,
                    exportProjectJson(project),
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
      {s.pendingRecovery.length > 0 && (
        <div className="workspace-notice" role="status">
          <span>Recovered drafts are available from your last session.</span>
          <RecoveredDrafts projectId={projectId} />
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              download(
                "recovered-drafts.json",
                JSON.stringify(s.pendingRecovery, null, 2),
                "application/json",
              )
            }
          >
            Download drafts
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (
                window.confirm(
                  "Discard the recovered drafts? This cannot be undone.",
                )
              )
                s.discardRecovery();
            }}
          >
            Discard
          </Button>
        </div>
      )}
      {readOnly && (
        <div className="workspace-notice" role="status">
          You have view access. You can read and download this project.
        </div>
      )}
      <div className="editor-body">
        {sidebar && (
          <aside className="file-sidebar">
            <div className="files-heading">
              <span>PROJECT FILES</span>
              <div className="flex items-center">
                <FileTrash project={project} />
                <input
                  ref={upload}
                  type="file"
                  multiple
                  className="sr-only"
                  aria-label="Upload project files"
                  disabled={readOnly || busy}
                  onChange={(e) => void uploadFiles(e.target.files)}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Upload files"
                  disabled={readOnly || busy}
                  onClick={() => upload.current?.click()}
                >
                  <Upload size={15} />
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      disabled={readOnly || busy}
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
            </div>
            <div className="file-root">
              <ChevronDown size={13} />
              <FolderOpen size={15} />
              <span>{project.name}</span>
            </div>
            <ProjectFiles
              files={project.files}
              selected={file?.id}
              dirty={s.dirty}
              readOnly={readOnly}
              onSelect={setSelected}
              onAction={(file, kind) => {
                setAction({ file, kind });
                setActionPath(file.path);
                setActionError("");
              }}
            />
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
          {collaborative && collaboration.state.error && (
            <div className="workspace-notice save-error" role="alert">
              <span>{collaboration.state.error}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void collaboration.session
                    ?.retry()
                    .catch((e) => toast.error(e.message))
                }
              >
                Retry connection / save
              </Button>
              {file && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => downloadFile(file)}
                >
                  Download draft
                </Button>
              )}
            </div>
          )}
          {file && s.saveErrors[file.id] && (
            <div className="workspace-notice save-error" role="alert">
              <span>{s.saveErrors[file.id]}</span>
              {!hasConflict && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void s
                      .saveFile(projectId, file.id)
                      .catch((e) => toast.error(e.message))
                  }
                >
                  Retry save
                </Button>
              )}
            </div>
          )}
          {file && hasConflict && (
            <div className="workspace-notice save-error">
              <span>
                {s.conflicts[file.id]
                  ? "The account copy changed. Your draft is preserved. Choose which version to keep."
                  : "The account copy is unavailable. Download your draft before reloading the project."}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => downloadFile(file)}
              >
                Download draft
              </Button>
              <Button
                disabled={readOnly || !s.conflicts[file.id]}
                size="sm"
                variant="outline"
                onClick={() => {
                  if (
                    window.confirm(
                      "Replace your local draft with the latest account copy? Your unsaved changes will be discarded.",
                    )
                  )
                    s.acceptRemote(projectId, file.id);
                }}
              >
                Use account copy
              </Button>
              <Button
                disabled={readOnly || !s.conflicts[file.id]}
                size="sm"
                onClick={() => {
                  if (
                    window.confirm(
                      "Keep your draft and overwrite the latest account copy?",
                    )
                  )
                    void s
                      .keepDraft(projectId, file.id)
                      .catch((e) => toast.error(e.message));
                }}
              >
                Keep my draft
              </Button>
            </div>
          )}
          <div className="code-surface">
            {file?.encoding === "base64" ? (
              <div className="asset-preview">
                {/^image\/(png|jpeg|gif|webp|avif)$/.test(
                  file.mimeType ?? "",
                ) ? (
                  <Image
                    unoptimized
                    width={1200}
                    height={900}
                    src={`data:${file.mimeType};base64,${file.content}`}
                    alt={file.path}
                  />
                ) : (
                  <FileText size={44} strokeWidth={1} />
                )}
                <h2>{file.path.split("/").pop()}</h2>
                <p>
                  {file.mimeType ?? "Binary asset"} ·{" "}
                  {Math.round((file.content.length * 3) / 4 / 1024)} KiB
                </p>
                <Button variant="outline" onClick={() => downloadFile(file)}>
                  <Download />
                  Download asset
                </Button>
              </div>
            ) : file && collaborative ? (
              collaboration.session && collaboration.state.ready ? (
                <CollaborativeEditor
                  key={`${s.accountId}:${file.id}`}
                  session={collaboration.session}
                  path={file.path}
                  wrap={wrap}
                  readOnly={readOnly}
                  onCreateEditor={(view) => {
                    editorView.current = view;
                    if (pendingLine.current) {
                      jumpToLine(view, pendingLine.current);
                      pendingLine.current = null;
                    }
                  }}
                />
              ) : (
                <div className="p-6" role="status">
                  Connecting to the live document…
                </div>
              )
            ) : file ? (
              <CodeMirror
                key={file.id}
                value={file.content}
                height="100%"
                editable={!readOnly}
                readOnly={readOnly}
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
                onCreateEditor={(view) => {
                  editorView.current = view;
                  if (pendingLine.current) {
                    jumpToLine(view, pendingLine.current);
                    pendingLine.current = null;
                  }
                }}
                onChange={(value) => {
                  if (!readOnly) s.editFile(projectId, file.id, value);
                }}
                className={cn("latex-code-editor", wrap && "wrap-code")}
                aria-label={`Source for ${file.path}`}
              />
            ) : (
              <div className="asset-preview">
                <FilePlus2 size={36} />
                <h2>A fresh start.</h2>
                <p>Add a file or upload your source to begin.</p>
                <Button disabled={readOnly} onClick={() => setNewFile(true)}>
                  Add file
                </Button>
              </div>
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
        <section
          className="preview-pane"
          aria-label="PDF preview"
          style={{ display: layout === "split" ? undefined : "none" }}
        >
          <CompilePanel
            key={project.id}
            project={project}
            onNavigateDiagnostic={(path: string, line?: number) => {
              const target = project.files.find((f) => f.path === path);
              if (!target) return;
              if (file?.id === target.id && editorView.current && line)
                jumpToLine(editorView.current, line);
              else {
                pendingLine.current = line ?? 1;
                setSelected(target.id);
              }
            }}
          />
        </section>
      </div>
      <footer className="editor-footer">
        <span>
          <span className="status-dot" />
          {s.mode === "local" ? (
            <>
              <HardDrive size={12} /> Local workspace · saved in this browser
            </>
          ) : (
            `Account workspace · ${collaboration.state.connected ? (collaboration.state.synchronized ? "live · synchronized" : "connected · synchronizing") : "offline"} · ${Math.max(0, collaboration.state.peers - 1)} collaborators · ⌘/Ctrl S to save now`
          )}
        </span>
        <Button
          className="mobile-preview-toggle"
          variant="ghost"
          size="xs"
          onClick={() => {
            setMobilePreview(!mobilePreview);
            setLayout("split");
            setSidebar(false);
          }}
        >
          <LayoutPanelLeft size={13} />
          {mobilePreview ? "Show source" : "PDF preview"}
        </Button>
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
            <Button type="submit" disabled={busy || readOnly}>
              {busy ? <Loader2 className="animate-spin" /> : <FilePlus2 />}
              Create file
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(action)}
        onOpenChange={(open) => {
          if (!open && !busy) setAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {action?.kind === "delete"
                ? "Move this file to Trash?"
                : "Rename or move file"}
            </DialogTitle>
            <DialogDescription>
              {action?.kind === "delete"
                ? `“${action.file.path}” will move to Trash, where you can restore it later. It will still count toward storage limits.`
                : "Set the full relative path. Folders are created automatically from file paths; empty folders are not stored."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitFileAction} className="space-y-4">
            {action?.kind === "rename" && (
              <>
                <label htmlFor="move-file-path" className="text-sm font-medium">
                  File path
                </label>
                <Input
                  id="move-file-path"
                  value={actionPath}
                  onChange={(e) => setActionPath(e.target.value)}
                  autoFocus
                  required
                  maxLength={240}
                />
                {s.dirty[action.file.id] && (
                  <p className="text-sm text-muted-foreground">
                    Your draft will be saved before this file moves.
                  </p>
                )}
              </>
            )}
            {actionError && (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setAction(null)}
              >
                Cancel
              </Button>
              <Button
                disabled={busy || readOnly}
                variant={action?.kind === "delete" ? "destructive" : "default"}
              >
                {busy && <Loader2 className="animate-spin" />}
                {action?.kind === "delete" ? "Move to Trash" : "Save path"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
function LeafIcon() {
  return <span className="editor-leaf">✳</span>;
}
