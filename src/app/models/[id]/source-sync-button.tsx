"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
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

type SyncPreview = {
  source: string;
  toImport: string[];
  toReplace: string[];
  toRemove: string[];
};

// A filename list for the preview dialog, capped so a 100-profile model
// doesn't produce a scrolling wall.
function FileList({ label, files }: { label: string; files: string[] }) {
  if (files.length === 0) return null;
  const shown = files.slice(0, 6);
  return (
    <div>
      <span className="font-medium text-foreground">{label}</span>
      <ul className="mt-0.5 list-disc pl-5">
        {shown.map((name) => (
          <li key={name} className="truncate">
            {name}
          </li>
        ))}
        {files.length > shown.length && (
          <li>… and {files.length - shown.length} more</li>
        )}
      </ul>
    </div>
  );
}

// "Sync from MakerWorld/Printables": first POST fetches a preview of what
// changed upstream; the dialog shows the concrete plan and a second POST
// with confirm applies it. Imported files mirror upstream — manually added
// files, title, description and images are never touched, and the pre-sync
// state stays restorable from History.
export function SourceSyncButton({
  modelId,
  sourceName,
}: {
  modelId: string;
  sourceName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<SyncPreview | null>(null);

  async function post(confirm: boolean) {
    const res = await fetch(`/api/models/${modelId}/source-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `Sync failed (${res.status})`);
    return body;
  }

  async function handleClick() {
    setBusy(true);
    try {
      const body = await post(false);
      if (body?.status === "preview") {
        setPreview({
          source: body.source ?? sourceName,
          toImport: body.toImport ?? [],
          toReplace: body.toReplace ?? [],
          toRemove: body.toRemove ?? [],
        });
      } else {
        toast.message(body?.message ?? `Already up to date with ${sourceName}.`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    setPreview(null);
    setBusy(true);
    try {
      const body = await post(true);
      const parts = [
        body?.imported ? `${body.imported} added` : null,
        body?.updated ? `${body.updated} updated` : null,
        body?.removed ? `${body.removed} removed` : null,
      ].filter(Boolean);
      toast.success(
        `Synced from ${sourceName}${parts.length ? ` — ${parts.join(", ")}` : ""}`,
      );
      for (const warning of body?.warnings ?? []) toast.warning(warning);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" disabled={busy} onClick={handleClick}>
        <RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} />
        {busy ? "Syncing… this can take a moment" : `Sync from ${sourceName}`}
      </Button>

      <AlertDialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sync from {preview?.source}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="grid gap-3 text-sm">
                {preview && (
                  <>
                    <FileList
                      label={`New upstream ${preview.toImport.length === 1 ? "file" : "files"} to import`}
                      files={preview.toImport}
                    />
                    <FileList
                      label={`Changed upstream — will be replaced`}
                      files={preview.toReplace}
                    />
                    <FileList
                      label={`Removed upstream — will be removed here`}
                      files={preview.toRemove}
                    />
                  </>
                )}
                <p>
                  Your manually added files, title, description and images are
                  not touched. The current state is kept in History and can be
                  restored.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm}>Sync</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
