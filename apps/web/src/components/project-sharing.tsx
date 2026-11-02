"use client";
import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import type { Project } from "@latex-free/shared";
import { useWorkspace } from "@/stores/workspace";
import { useProjectDetails } from "@/stores/project-details";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function ProjectSharing({ project }: { project: Project }) {
  const account = useWorkspace((s) => s.mode === "account");
  const d = useProjectDetails();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"EDITOR" | "VIEWER">("EDITOR");
  const key = `members:${project.id}`;
  const busy = d.loading[key];
  const owner = project.role === "OWNER";
  useEffect(() => {
    if (open && account && owner)
      void useProjectDetails
        .getState()
        .loadMembers(project.id)
        .catch(() => {});
  }, [open, account, owner, project.id]);
  if (account && !owner) return null;
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Users /> Share
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Share project</DialogTitle>
            <DialogDescription>
              {account
                ? "Add people who have signed in with Google at least once. Access is granted immediately; no invitation email is sent. Editors can change files; viewers can read and download them."
                : "Sign in and create or import an account project to share it. This local project stays in this browser; use Export to download a backup."}
            </DialogDescription>
          </DialogHeader>
          {account && owner && (
            <>
              <form
                className="space-y-3"
                onSubmit={async (event) => {
                  event.preventDefault();
                  try {
                    await d.addMember(project.id, email.trim(), role);
                    setEmail("");
                  } catch {
                    /* Store shows request error. */
                  }
                }}
              >
                <label htmlFor="member-email" className="text-sm font-medium">
                  Google account email
                </label>
                <Input
                  id="member-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy}
                />
                <div className="flex items-center gap-2">
                  <select
                    aria-label="New member role"
                    className="rounded-md border p-2 text-sm"
                    value={role}
                    disabled={busy}
                    onChange={(e) => setRole(e.target.value as typeof role)}
                  >
                    <option value="EDITOR">Editor</option>
                    <option value="VIEWER">Viewer</option>
                  </select>
                  <Button type="submit" disabled={busy}>
                    {busy ? "Please wait…" : "Add member"}
                  </Button>
                </div>
              </form>
              {d.errors[key] && (
                <p role="alert" className="text-sm text-destructive">
                  {d.errors[key]}
                </p>
              )}
              {busy && (
                <p role="status" className="text-sm text-muted-foreground">
                  Updating project access…
                </p>
              )}
              <ul aria-label="Project members" className="space-y-3">
                {(d.members[project.id] ?? []).map((member) => (
                  <li
                    key={member.userId}
                    className="flex flex-wrap items-center justify-between gap-2 border-t pt-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium break-words">
                        {member.name}
                      </p>
                      <p className="text-xs text-muted-foreground break-all">
                        {member.email}
                      </p>
                    </div>
                    {member.role === "OWNER" ? (
                      <span className="text-sm">Owner</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <select
                          aria-label={`Role for ${member.email}`}
                          className="rounded-md border p-2 text-sm"
                          disabled={busy}
                          value={member.role}
                          onChange={(e) =>
                            void d
                              .changeRole(
                                project.id,
                                member.userId,
                                e.target.value as "EDITOR" | "VIEWER",
                              )
                              .catch(() => {})
                          }
                        >
                          <option value="EDITOR">Editor</option>
                          <option value="VIEWER">Viewer</option>
                        </select>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Remove ${member.email} from this project?`,
                              )
                            )
                              void d
                                .removeMember(project.id, member.userId)
                                .catch(() => {});
                          }}
                        >
                          Remove<span className="sr-only"> {member.email}</span>
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {d.errors[key] && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void d.loadMembers(project.id).catch(() => {})}
                >
                  Reload members
                </Button>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
