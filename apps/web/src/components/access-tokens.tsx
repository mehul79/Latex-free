"use client";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  Settings2,
} from "lucide-react";
import { API_URL } from "@/lib/api";
import { useWorkspace } from "@/stores/workspace";
import {
  useAccessTokens,
  tokenScopes,
  type TokenScope,
  type TokenMetadata,
} from "@/stores/access-tokens";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const scopeLabels: Record<TokenScope, string> = {
  "projects:read": "Read project details",
  "files:read": "Read files",
  "files:write": "Edit files",
  compile: "Compile projects",
  "projects:share": "Manage project sharing",
};
const date = (value: string) => new Date(value).toLocaleDateString();

export function AccessTokens({
  open,
  onOpenChange,
  onSignIn,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSignIn: () => void;
}) {
  const accountId = useWorkspace((s) => s.accountId);
  const mode = useWorkspace((s) => s.mode);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        {open &&
          (mode === "account" && accountId ? (
            <AccountTokens key={accountId} />
          ) : (
            <>
              <DialogHeader>
                <span className="dialog-icon">
                  <Settings2 />
                </span>
                <DialogTitle>Account settings</DialogTitle>
                <DialogDescription>
                  Sign in to create access tokens for your account projects.
                </DialogDescription>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                Access tokens let MCP clients use only the projects and
                permissions you choose. Local browser projects are not available
                through MCP.
              </p>
              <Button
                onClick={() => {
                  onOpenChange(false);
                  onSignIn();
                }}
              >
                Sign in with Google
              </Button>
            </>
          ))}
      </DialogContent>
    </Dialog>
  );
}
function AccountTokens() {
  const store = useAccessTokens();
  const projects = useWorkspace((s) => s.projects);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<TokenScope[]>([
    "projects:read",
    "files:read",
  ]);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [expiresInDays, setExpiry] = useState(30);
  // A one-time secret lives only in this mounted dialog. Never send it to a store.
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [revoking, setRevoking] = useState<TokenMetadata | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    void useAccessTokens.getState().load();
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!label.trim() || !projectIds.length || !scopes.length) return;
    try {
      const token = await store.createToken({
        label: label.trim(),
        scopes,
        projectIds,
        expiresInDays,
      });
      if (token) setSecret(token);
    } catch {
      /* The account store presents the server error. */
    }
  }
  function back() {
    setSecret(null);
    setCreating(false);
    setCopied(false);
    setCopyError(false);
    setLabel("");
    setProjectIds([]);
    setScopes(["projects:read", "files:read"]);
    setExpiry(30);
  }
  return (
    <>
      <DialogHeader>
        <span className="dialog-icon">
          <KeyRound />
        </span>
        <DialogTitle>
          {secret
            ? "Save your access token"
            : creating
              ? "Create access token"
              : "Account settings"}
        </DialogTitle>
        <DialogDescription>
          {secret
            ? "Copy it now. You cannot recover this token after leaving this dialog."
            : creating
              ? "Choose an expiration, permissions, and the account projects this token can access."
              : "Access tokens for MCP clients and your account projects."}
        </DialogDescription>
      </DialogHeader>
      {store.error && (
        <p role="alert" className="text-sm text-destructive">
          {store.error}
        </p>
      )}
      {secret ? (
        <div className="space-y-4">
          <label htmlFor="created-access-token" className="text-sm font-medium">
            Your new token
          </label>
          <textarea
            id="created-access-token"
            aria-label="Created access token"
            readOnly
            value={secret}
            className="min-h-24 w-full rounded-md border bg-muted/40 p-3 font-mono text-xs break-all"
            onFocus={(event) => event.target.select()}
          />
          <p className="text-sm text-muted-foreground">
            Keep it private, like a password. If you lose it, revoke it and
            create another.
          </p>
          {copyError && (
            <p role="alert" className="text-sm text-destructive">
              Clipboard access failed. Select the token above and copy it
              manually before continuing.
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              disabled={copied}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(secret);
                  setCopied(true);
                  setCopyError(false);
                } catch {
                  setCopyError(true);
                }
              }}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy token"}
            </Button>
            <Button onClick={back}>I have saved my token</Button>
          </div>
        </div>
      ) : creating ? (
        <form onSubmit={create} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="token-label" className="text-sm font-medium">
              Token name
            </label>
            <Input
              id="token-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="My research assistant"
              maxLength={80}
              required
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="token-expiry" className="text-sm font-medium">
              Expires after
            </label>
            <select
              id="token-expiry"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={expiresInDays}
              onChange={(event) => setExpiry(Number(event.target.value))}
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </div>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Permissions</legend>
            {tokenScopes.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={scopes.includes(scope)}
                  onChange={(event) =>
                    setScopes((current) =>
                      event.target.checked
                        ? [...current, scope]
                        : current.filter((value) => value !== scope),
                    )
                  }
                />
                {scopeLabels[scope]}
              </label>
            ))}
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">
              Allowed projects ({projectIds.length}/100)
            </legend>
            <div className="max-h-40 space-y-2 overflow-y-auto rounded-md border p-3">
              {projects.length ? (
                projects.map((project) => (
                  <label
                    key={project.id}
                    className="flex items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={projectIds.includes(project.id)}
                      disabled={
                        projectIds.length >= 100 &&
                        !projectIds.includes(project.id)
                      }
                      onChange={(event) =>
                        setProjectIds((current) =>
                          event.target.checked
                            ? [...current, project.id]
                            : current.filter((id) => id !== project.id),
                        )
                      }
                    />
                    <span className="min-w-0 break-words">{project.name}</span>
                  </label>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  Create an account project first.
                </p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Select at least one project. Permissions also require your current
              role in each project.
            </p>
          </fieldset>
          <div className="flex justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={store.busy}
              onClick={back}
            >
              <ArrowLeft />
              Back
            </Button>
            <Button
              disabled={
                store.busy ||
                !label.trim() ||
                !scopes.length ||
                !projectIds.length
              }
            >
              {store.busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
              Create token
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-5">
          <div className="space-y-2 rounded-lg border bg-muted/30 p-3 text-sm">
            <p className="font-medium">MCP connection</p>
            <code className="block break-all text-xs">
              {API_URL.replace(/\/$/, "")}/mcp
            </code>
            <p className="text-xs text-muted-foreground">
              Use this endpoint in your MCP client with an Authorization header:
              Bearer &lt;your token&gt;. Each request requires the token’s
              permissions and your current project role.
            </p>
          </div>
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-medium">Access tokens</h3>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              New token
            </Button>
          </div>
          {store.loading ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading tokens…
            </p>
          ) : store.tokens.length ? (
            <ul className="space-y-3">
              {store.tokens.map((token) => {
                const status = token.revokedAt
                  ? "Revoked"
                  : new Date(token.expiresAt).getTime() <= now
                    ? "Expired"
                    : "Active";
                return (
                  <li
                    key={token.id}
                    className="space-y-2 rounded-lg border p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium">
                          {token.label}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {status} · {token.projectIds.length}{" "}
                          {token.projectIds.length === 1
                            ? "project"
                            : "projects"}{" "}
                          · Expires {date(token.expiresAt)}
                        </p>
                      </div>
                      {status === "Active" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={store.busy}
                          onClick={() => setRevoking(token)}
                        >
                          Revoke
                        </Button>
                      )}
                    </div>
                    <p className="break-words text-xs text-muted-foreground">
                      {token.scopes
                        .map((scope) => scopeLabels[scope])
                        .join(" · ")}
                    </p>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No access tokens yet. Create one to connect an MCP client.
            </p>
          )}
          {store.error && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void store.load()}
            >
              Retry loading tokens
            </Button>
          )}
        </div>
      )}
      <AlertDialog
        open={Boolean(revoking)}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this access token?</AlertDialogTitle>
            <AlertDialogDescription>
              Clients using “{revoking?.label}” will lose access immediately.
              You can create a new token later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep token</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (revoking)
                  void store.revoke(revoking.id).catch(() => undefined);
              }}
            >
              Revoke token
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
