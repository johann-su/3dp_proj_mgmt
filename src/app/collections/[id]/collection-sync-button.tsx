"use client";

import { useState } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IMPORT_JOB_STARTED_EVENT } from "@/components/import-progress";

// Owner-only "Sync from MakerWorld" button on imported collections: starts a
// background import job against the stored source URL. New remote designs
// import as models; progress shows in the header indicator like the initial
// import.
export function CollectionSyncButton({ collectionId }: { collectionId: string }) {
  const [starting, setStarting] = useState(false);

  async function handleSync() {
    setStarting(true);
    try {
      const res = await fetch(`/api/collections/${collectionId}/sync`, {
        method: "POST",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error ?? `Sync failed (${res.status})`);
      }
      window.dispatchEvent(new Event(IMPORT_JOB_STARTED_EVENT));
      toast.success(
        "Syncing in the background — new models appear as they finish",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setStarting(false);
    }
  }

  return (
    <Button variant="outline" size="sm" disabled={starting} onClick={handleSync}>
      <RefreshCw className={starting ? "size-4 animate-spin" : "size-4"} />
      Sync from MakerWorld
    </Button>
  );
}
