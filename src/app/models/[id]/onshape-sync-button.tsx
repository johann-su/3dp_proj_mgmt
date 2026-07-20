"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Box, Boxes, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
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

type NewTab = {
  id: string;
  name: string;
  elementType: "PARTSTUDIO" | "ASSEMBLY";
};

// "Sync from Onshape" button (any signed-in user — syncing counts as
// editing): re-exports the source document and replaces the exported 3MF
// files when the Onshape workspace has new changes. When the document grew
// tabs the model doesn't carry yet, the route answers `needs-selection`
// first and this component opens a picker — the only way to add upstream
// tabs to an existing model without re-importing it.
export function OnshapeSyncButton({ modelId }: { modelId: string }) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState<{
    newTabs: NewTab[];
    microversionChanged: boolean;
    maxAdd: number;
  } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  async function runSync(addElementIds?: string[]) {
    setSyncing(true);
    try {
      const res = await fetch(`/api/models/${modelId}/onshape-sync`, {
        method: "POST",
        ...(addElementIds
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ addElementIds }),
            }
          : {}),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error ?? `Sync failed (${res.status})`);
      }
      if (body?.status === "needs-selection") {
        // Same defaults as the import dialog: Part Studios are printable
        // geometry, assembly exports overlap when sliced.
        const newTabs: NewTab[] = Array.isArray(body.newTabs) ? body.newTabs : [];
        const maxAdd = typeof body.maxAdd === "number" ? body.maxAdd : 0;
        setSelected(
          newTabs
            .filter((t) => t.elementType === "PARTSTUDIO")
            .slice(0, maxAdd)
            .map((t) => t.id),
        );
        setPending({
          newTabs,
          microversionChanged: body.microversionChanged === true,
          maxAdd,
        });
        return;
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

  function toggleTab(id: string, checked: boolean) {
    setSelected((prev) =>
      checked ? [...prev, id] : prev.filter((tabId) => tabId !== id),
    );
  }

  function confirmSync() {
    const addElementIds = selected;
    setPending(null);
    void runSync(addElementIds);
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={syncing}
        onClick={() => runSync()}
      >
        <RefreshCw className={syncing ? "size-4 animate-spin" : "size-4"} />
        {syncing ? "Syncing… this can take a moment" : "Sync from Onshape"}
      </Button>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>New tabs in Onshape</AlertDialogTitle>
            <AlertDialogDescription>
              The linked document has tabs that aren&apos;t part of this model.
              Pick which to add — Assemblies export their parts in assembled
              positions, so interlocking parts overlap when sliced.
              {pending?.microversionChanged
                ? " The files already imported are updated as well."
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending ? (
            <div className="grid gap-1.5 max-h-72 overflow-y-auto pr-1">
              {pending.newTabs.map((tab) => {
                const checked = selected.includes(tab.id);
                const full = selected.length >= pending.maxAdd;
                return (
                  <label
                    key={tab.id}
                    className="flex items-center gap-3 cursor-pointer rounded-md border px-3 py-2"
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={checked}
                      disabled={!checked && full}
                      onChange={(e) => toggleTab(tab.id, e.target.checked)}
                    />
                    {tab.elementType === "PARTSTUDIO" ? (
                      <Box className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <Boxes className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex-1 truncate text-sm">{tab.name}</span>
                  </label>
                );
              })}
              {pending.newTabs.length > pending.maxAdd && (
                <p className="text-xs text-muted-foreground">
                  Up to {pending.maxAdd} more tab(s) fit this model&apos;s
                  export limit.
                </p>
              )}
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmSync}>
              {selected.length === 0
                ? "Sync without adding"
                : `Add ${selected.length} tab${selected.length === 1 ? "" : "s"} & sync`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
