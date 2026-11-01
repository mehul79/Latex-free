"use client";
import { useState } from "react";
import { ArrowUpRight, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { authClient } from "@/lib/auth-client";
import { api } from "@/lib/api";
export function SignInDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function signIn() {
    setBusy(true);
    setError("");
    try {
      const config = await api<{ googleEnabled: boolean }>("/config");
      if (!config.googleEnabled)
        throw new Error(
          "Google sign-in isn’t configured yet. Add Google OAuth credentials to the API environment to enable it. You can keep using the local workspace.",
        );
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: window.location.origin,
      });
      if (result.error)
        throw new Error(result.error.message ?? "Could not sign in");
    } catch (error) {
      setError(
        (error as Error).message ||
          "The API is unavailable. Please try again later.",
      );
      toast.error("Sign-in unavailable");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <span className="dialog-icon">
            <ShieldCheck />
          </span>
          <DialogTitle className="font-display text-3xl font-normal">
            A home for your work.
          </DialogTitle>
          <DialogDescription>
            Sign in to save projects to your account and access them across
            devices.
          </DialogDescription>
        </DialogHeader>
        <Button
          variant="outline"
          onClick={() => void signIn()}
          disabled={busy}
          className="h-12 w-full"
        >
          {busy ? (
            <Loader2 className="animate-spin" />
          ) : (
            <>
              <span className="font-bold text-lg">G</span> Continue with Google{" "}
              <ArrowUpRight className="ml-auto" />
            </>
          )}
        </Button>
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
          >
            {error}
          </p>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Local projects stay in this browser. Signing in opens a separate
          account workspace; local projects are not uploaded automatically.
        </p>
      </DialogContent>
    </Dialog>
  );
}
