"use client";
import { useEffect } from "react";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useWorkspace } from "@/stores/workspace";
import { authClient } from "@/lib/auth-client";
export function Providers({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const connect = useWorkspace((s) => s.connect);
  useEffect(() => {
    void Promise.resolve(useWorkspace.persist.rehydrate()).then(() =>
      useWorkspace.getState().setHydrated(),
    );
  }, []);
  useEffect(() => {
    if (!isPending) void connect(session?.user.id ?? null);
  }, [session?.user.id, isPending, connect]);
  return (
    <TooltipProvider>
      {children}
      <Toaster position="bottom-right" richColors closeButton />
    </TooltipProvider>
  );
}
