"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowDownAZ,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  CircleHelp,
  FileText,
  FolderOpen,
  Grid2X2,
  Leaf,
  List,
  Loader2,
  LogOut,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Sparkles,
  Star,
  Trash2,
  X,
  Pencil,
  HardDrive,
} from "lucide-react";
import { toast } from "sonner";
import { templates, type Project, type TemplateId } from "@latex-free/shared";
import { useWorkspace } from "@/stores/workspace";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ProjectDialog } from "./project-dialog";
import { SignInDialog } from "./sign-in-dialog";
import { PaperThumbnail } from "./paper-thumbnail";

function relativeDate(date: string) {
  const seconds = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
export function Dashboard() {
  const s = useWorkspace();
  const { data: session } = authClient.useSession();
  const [create, setCreate] = useState<TemplateId | null>(null);
  const [signIn, setSignIn] = useState(false);
  const [help, setHelp] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [action, setAction] = useState<{
    project: Project;
    kind: "rename" | "delete";
  } | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const visible = s.projects
    .filter(
      (p) =>
        (s.section !== "starred" || p.starred) &&
        p.name.toLowerCase().includes(s.query.toLowerCase()),
    )
    .sort((a, b) =>
      s.sort === "name"
        ? a.name.localeCompare(b.name)
        : b.updatedAt.localeCompare(a.updatedAt),
    );
  async function submitAction(e: React.FormEvent) {
    e.preventDefault();
    if (!action) return;
    if (action.kind === "rename" && !name.trim()) return;
    setBusy(true);
    try {
      if (action.kind === "delete") await s.deleteProject(action.project.id);
      else await s.renameProject(action.project.id, name.trim());
      toast.success(
        action.kind === "delete" ? "Project deleted" : "Project renamed",
      );
      setAction(null);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="dashboard-shell">
      {mobileMenu && (
        <button
          aria-label="Close navigation"
          className="sidebar-backdrop"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <aside className={cn("sidebar", mobileMenu && "sidebar-open")}>
        <Link href="/" className="brand">
          <span className="brand-mark">
            ℓ<span>f</span>
          </span>
          <span>
            latex<span className="brand-dash">-</span>free
            <span className="brand-dot">.</span>
          </span>
        </Link>
        <button className="workspace-switch" onClick={() => setHelp(true)}>
          <span className="workspace-avatar">
            {session?.user.name?.slice(0, 1) ?? "P"}
          </span>
          <span>
            <strong>Personal workspace</strong>
            <small>
              {s.mode === "local" ? "Local · this browser" : "Your account"}
            </small>
          </span>
          <ChevronDown size={14} />
        </button>
        <div className="nav-caption">WORKSPACE</div>
        <nav aria-label="Workspace navigation">
          {(
            [
              { id: "projects", label: "All projects", icon: FolderOpen },
              { id: "starred", label: "Starred", icon: Star },
              { id: "templates", label: "Templates", icon: BookOpen },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={cn("nav-item", s.section === item.id && "active")}
              onClick={() => {
                s.setFilter({ section: item.id, query: "" });
                setMobileMenu(false);
              }}
            >
              <item.icon size={18} />
              {item.label}
              {item.id === "projects" && (
                <span className="nav-count">{s.projects.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <Leaf size={21} />
            <p>
              Less formatting.
              <br />
              <span>More possibility.</span>
            </p>
            <small>A little space for your big ideas.</small>
          </div>
          <button className="nav-item help-nav" onClick={() => setHelp(true)}>
            <CircleHelp size={18} /> A little help
          </button>
          <div className="sidebar-user">
            <span className="user-avatar">
              {session?.user.name?.slice(0, 1) ?? "Y"}
            </span>
            <span>
              <strong>{session?.user.name ?? "Your local workspace"}</strong>
              <small>
                {session ? "Connected account" : "Make yourself at home"}
              </small>
            </span>
            {session ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Sign out"
                    onClick={async () => {
                      await authClient.signOut();
                      toast.success("Signed out");
                    }}
                  >
                    <LogOut size={15} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Sign out</TooltipContent>
              </Tooltip>
            ) : (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Sign in"
                onClick={() => setSignIn(true)}
              >
                <ArrowUpRight size={17} />
              </Button>
            )}
          </div>
        </div>
      </aside>
      <div className="dashboard-main">
        <header className="topbar">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobileMenu(true)}
            >
              <Menu />
            </Button>
            <span className="breadcrumb-label">Workspace</span>
            <span className="breadcrumb-slash">/</span>
            <span>
              {s.section === "projects"
                ? "All projects"
                : s.section === "starred"
                  ? "Starred"
                  : "Templates"}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="outline" className="local-badge">
              <span className="status-dot" />
              {s.mode === "local" ? "Local workspace" : "Connected"}
            </Badge>
            {!session && (
              <Button variant="ghost" size="sm" onClick={() => setSignIn(true)}>
                Sign in <ArrowUpRight />
              </Button>
            )}
          </div>
        </header>
        <main className="dashboard-content">
          <section className="welcome-section">
            <div>
              <div className="eyebrow">
                <span className="tiny-star">✳</span> ROOM TO THINK. SPACE TO
                CREATE.
              </div>
              <h1>
                {s.section === "templates" ? (
                  <>
                    A good place to <em>begin.</em>
                  </>
                ) : s.section === "starred" ? (
                  <>
                    Keep your favorites <em>close.</em>
                  </>
                ) : (
                  <>
                    Big ideas start <em>here.</em>
                  </>
                )}
              </h1>
              <p>
                {s.section === "templates"
                  ? "A few thoughtful starting points, ready for your next idea."
                  : s.section === "starred"
                    ? "Your most-loved projects, all in one little corner."
                    : "Your papers, projects, and next possibilities. All in one place."}
              </p>
            </div>
            <Button
              className="new-project-button"
              onClick={() => setCreate("blank")}
            >
              <Plus size={17} /> New project
            </Button>
          </section>
          {s.section !== "starred" && (
            <section
              className="template-section"
              aria-labelledby="templates-heading"
            >
              <div className="section-heading">
                <h2 id="templates-heading">
                  {s.section === "templates"
                    ? "Choose your starting point"
                    : "Start with a little inspiration"}
                </h2>
                <span>
                  Yours to make your own <ArrowDownAZ size={13} />
                </span>
              </div>
              <div className="template-grid">
                {templates.map((template) => (
                  <button
                    key={template.id}
                    className={cn(
                      "template-card",
                      `template-card-${template.id}`,
                    )}
                    onClick={() => setCreate(template.id)}
                  >
                    <div className="template-art">
                      {template.id === "blank" ? (
                        <div className="blank-art">
                          <Plus size={28} strokeWidth={1} />
                          <span>Anything is possible.</span>
                        </div>
                      ) : (
                        <PaperThumbnail template={template.id} />
                      )}
                      <span className="template-arrow">
                        <ArrowUpRight size={16} />
                      </span>
                    </div>
                    <div className="template-copy">
                      <strong>{template.name}</strong>
                      <span>{template.description}</span>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}
          {s.section !== "templates" && (
            <section
              className="projects-section"
              aria-labelledby="projects-heading"
            >
              <div className="projects-heading-row">
                <div className="section-heading project-title">
                  <h2 id="projects-heading">
                    {s.section === "starred"
                      ? "Starred projects"
                      : "Your projects"}
                  </h2>
                  <span className="project-count">
                    {
                      s.projects.filter(
                        (p) => s.section !== "starred" || p.starred,
                      ).length
                    }
                  </span>
                </div>
                <div className="project-controls">
                  <div className="search-box">
                    <Search size={15} />
                    <Input
                      ref={search}
                      value={s.query}
                      onChange={(e) => s.setFilter({ query: e.target.value })}
                      placeholder="Find a project..."
                      aria-label="Search projects"
                    />
                    {s.query ? (
                      <button
                        aria-label="Clear search"
                        onClick={() => s.setFilter({ query: "" })}
                      >
                        <X size={13} />
                      </button>
                    ) : (
                      <kbd>⌘ K</kbd>
                    )}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="sort-button">
                        {s.sort === "updated" ? "Last edited" : "Name"}
                        <ChevronDown size={14} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() => s.setFilter({ sort: "updated" })}
                      >
                        Last edited{" "}
                        {s.sort === "updated" && <Check className="ml-auto" />}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => s.setFilter({ sort: "name" })}
                      >
                        Name{" "}
                        {s.sort === "name" && <Check className="ml-auto" />}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <div className="view-toggle" aria-label="Project display">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Grid view"
                      aria-pressed={s.view === "grid"}
                      onClick={() => s.setFilter({ view: "grid" })}
                    >
                      <Grid2X2 size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="List view"
                      aria-pressed={s.view === "list"}
                      onClick={() => s.setFilter({ view: "list" })}
                    >
                      <List size={16} />
                    </Button>
                  </div>
                </div>
              </div>
              {s.error ? (
                <div role="alert" className="empty-state">
                  <CircleHelp />
                  <h3>We couldn’t load your projects.</h3>
                  <p>{s.error}</p>
                  <Button
                    variant="outline"
                    onClick={() => void s.connect(session?.user.id ?? null)}
                  >
                    Try again
                  </Button>
                </div>
              ) : !s.hydrated || s.loading ? (
                <div className="project-grid">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-64 rounded-xl" />
                  ))}
                </div>
              ) : visible.length ? (
                <div
                  className={
                    s.view === "grid" ? "project-grid" : "project-list"
                  }
                >
                  {visible.map((project) => (
                    <Card
                      key={project.id}
                      className={cn(
                        "project-card group",
                        s.view === "list" && "project-card-list",
                      )}
                    >
                      <Link
                        href={`/projects/${project.id}`}
                        className="project-preview"
                        aria-label={`Open ${project.name}`}
                      >
                        <PaperThumbnail template={project.template} />
                        <span className="open-project">
                          Open project <ArrowUpRight size={14} />
                        </span>
                      </Link>
                      <CardContent className="project-card-details">
                        <div className="project-name-row">
                          <Link
                            href={`/projects/${project.id}`}
                            className="project-name"
                          >
                            {project.name}
                          </Link>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={
                              project.starred
                                ? `Unstar ${project.name}`
                                : `Star ${project.name}`
                            }
                            className={cn(
                              "star-button",
                              project.starred && "starred",
                            )}
                            onClick={() =>
                              void s
                                .toggleStar(project.id)
                                .catch((e) => toast.error(e.message))
                            }
                          >
                            <Star
                              size={15}
                              fill={project.starred ? "currentColor" : "none"}
                            />
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Options for ${project.name}`}
                              >
                                <MoreHorizontal size={17} />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onSelect={() => {
                                  setAction({ project, kind: "rename" });
                                  setName(project.name);
                                }}
                              >
                                <Pencil />
                                Rename
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() =>
                                  setAction({ project, kind: "delete" })
                                }
                              >
                                <Trash2 />
                                Delete project
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        <div className="project-meta">
                          <span>
                            <FileText size={12} />
                            {project.files.length}{" "}
                            {project.files.length === 1 ? "file" : "files"}
                          </span>
                          <span>Edited {relativeDate(project.updatedAt)}</span>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <span className="empty-icon">
                    {s.query ? (
                      <Search />
                    ) : s.section === "starred" ? (
                      <Star />
                    ) : (
                      <FolderOpen />
                    )}
                  </span>
                  <h3>
                    {s.query
                      ? "No projects found."
                      : s.section === "starred"
                        ? "A place for your favorites."
                        : "Your first chapter starts here."}
                  </h3>
                  <p>
                    {s.query
                      ? "Try another name, or start something new."
                      : s.section === "starred"
                        ? "Star a project to keep it within easy reach."
                        : "A paper, a resume, a half-formed idea. Give it a home."}
                  </p>
                  <Button
                    variant="outline"
                    onClick={() =>
                      s.query
                        ? s.setFilter({ query: "" })
                        : s.section === "starred"
                          ? s.setFilter({ section: "projects" })
                          : setCreate("blank")
                    }
                  >
                    {s.query
                      ? "Clear search"
                      : s.section === "starred"
                        ? "Explore projects"
                        : "Create your first project"}
                    <ArrowRight size={14} />
                  </Button>
                </div>
              )}
            </section>
          )}
          <footer className="workspace-footer">
            <span>
              <Leaf size={14} /> A little less friction. A little more flow.
            </span>
            <span>
              {s.mode === "local" ? (
                <>
                  <HardDrive size={13} /> Saved in this browser
                </>
              ) : (
                <>
                  <Check size={13} /> Account workspace
                </>
              )}
            </span>
          </footer>
        </main>
      </div>
      {create && (
        <ProjectDialog
          key={create}
          open
          onOpenChange={(open) => {
            if (!open) setCreate(null);
          }}
          initialTemplate={create}
        />
      )}
      <SignInDialog open={signIn} onOpenChange={setSignIn} />
      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent>
          <DialogHeader>
            <span className="dialog-icon">
              <Leaf />
            </span>
            <DialogTitle className="font-display text-3xl font-normal">
              Welcome to your workspace.
            </DialogTitle>
            <DialogDescription>
              A calm place to write, organize, and develop your next idea.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
            <p>
              <strong className="text-foreground">Start small.</strong> Choose a
              template or create a blank project. Edit LaTeX in the source
              editor and add text files from the file tree.
            </p>
            <p>
              <strong className="text-foreground">
                Your work stays with you.
              </strong>{" "}
              Local projects are saved in this browser. Use Download source in
              the editor to keep a backup. Account projects use the Express API.
            </p>
            <p>
              <strong className="text-foreground">Still growing.</strong>{" "}
              Compilation, live collaboration, MCP, and AI assistance are coming
              in later milestones.
            </p>
          </div>
          <Button onClick={() => setHelp(false)}>
            Make yourself at home <Sparkles size={15} />
          </Button>
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
                ? "Delete this project?"
                : "Rename project"}
            </DialogTitle>
            <DialogDescription>
              {action?.kind === "delete"
                ? `“${action.project.name}” and its files will be permanently deleted. Download a backup first if you need one.`
                : "A new name for the same idea."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitAction} className="space-y-4">
            {action?.kind === "rename" && (
              <>
                <label className="sr-only" htmlFor="rename">
                  Project name
                </label>
                <Input
                  autoFocus
                  id="rename"
                  value={name}
                  maxLength={100}
                  required
                  onChange={(e) => setName(e.target.value)}
                />
              </>
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
                disabled={busy || (action?.kind === "rename" && !name.trim())}
                variant={action?.kind === "delete" ? "destructive" : "default"}
              >
                {busy ? (
                  <Loader2 className="animate-spin" />
                ) : action?.kind === "delete" ? (
                  "Delete project"
                ) : (
                  "Save name"
                )}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
