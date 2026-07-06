"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

// Owner-only "Sync from Onshape" button: re-exports the source document and
// replaces the exported 3MF files when the Onshape workspace has new changes.
export function OnshapeSyncButton({ modelId }: { modelId: string }) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await fetch(`/api/models/${modelId}/onshape-sync`, {
        method: "POST",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error ?? `Sync failed (${res.status})`);
      }
      if (body?.status === "updated") {
        toast.success(
          `Synced from Onshape — ${body.files?.length ?? 0} file(s) updated`,
        );
        for (const warning of body.warnings ?? []) toast.warning(warning);
        router.refresh();
      } else {
        toast.message(body?.message ?? "Already up to date with Onshape.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <Button variant="outline" size="sm" disabled={syncing} onClick={handleSync}>
      <RefreshCw className={syncing ? "size-4 animate-spin" : "size-4"} />
      {syncing ? "Syncing… this can take a moment" : "Sync from Onshape"}
    </Button>
  );
}
