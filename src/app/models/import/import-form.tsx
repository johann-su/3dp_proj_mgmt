"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CloudDownload } from "lucide-react";
import { IMPORT_DRAFT_KEY } from "@/app/models/import-draft";
import { IMPORT_JOB_STARTED_EVENT } from "@/components/import-progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
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

// MakerWorld collection URLs get a whole-collection background import instead
// of the single-model draft flow. Mirrors parseMakerworldCollectionUrl.
function isMakerworldCollectionUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      /(^|\.)makerworld\.com$/.test(url.hostname) &&
      /\/collections\/\d+/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function ImportForm() {
  const router = useRouter();
  const [fetching, setFetching] = useState(false);
  // Set when the importer reports a model has a lot of files — drives the
  // Continue/Cancel confirmation dialog before we download them all.
  const [pendingConfirm, setPendingConfirm] = useState<{
    url: string;
    fileCount: number;
    title: string;
  } | null>(null);

  async function importCollection(url: string) {
    const res = await fetch("/api/import/collection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(body?.error ?? `Import failed (${res.status})`);
    }
    window.dispatchEvent(new Event(IMPORT_JOB_STARTED_EVENT));
    toast.success(
      `Importing “${body.title}” in the background — models appear in the collection as they finish`,
    );
    router.push(`/collections/${body.collectionId}`);
  }

  async function importModel(url: string, confirm = false) {
    const res = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, confirm }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(body?.error ?? `Import failed (${res.status})`);
    }
    // The model has a lot of files — pause and open the Continue/Cancel dialog
    // before downloading them all. The dialog is modal, so drop the fetching
    // state; it resumes when the user confirms.
    if (body?.needsConfirmation) {
      setFetching(false);
      setPendingConfirm({
        url,
        fileCount: body.fileCount ?? 0,
        title: body.title ?? "",
      });
      return;
    }
    sessionStorage.setItem(IMPORT_DRAFT_KEY, JSON.stringify(body));
    router.push("/models/new");
  }

  async function confirmImport() {
    if (!pendingConfirm) return;
    const { url } = pendingConfirm;
    setPendingConfirm(null);
    setFetching(true);
    try {
      await importModel(url, true);
    } catch (err) {
      setFetching(false);
      toast.error(err instanceof Error ? err.message : "Import failed");
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const url = String(new FormData(e.currentTarget).get("url")).trim();
    setFetching(true);
    try {
      if (isMakerworldCollectionUrl(url)) {
        await importCollection(url);
      } else {
        await importModel(url);
      }
    } catch (err) {
      setFetching(false);
      toast.error(err instanceof Error ? err.message : "Import failed");
    }
  }

  return (
    <>
    <Card>
      <CardContent>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="url">Model or collection URL</Label>
            <Input
              id="url"
              name="url"
              type="url"
              required
              placeholder="https://www.printables.com/model/3161-3d-benchy"
              disabled={fetching}
            />
          </div>
          <Button type="submit" disabled={fetching} className="justify-self-start">
            <CloudDownload className="size-4" />
            {fetching ? "Fetching model… this can take a moment" : "Fetch model"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Printables: metadata, images and model files are imported. <br />
            MakerWorld: metadata and images always import; the <code>.3mf</code>
            files import too once you{" "}
            <Link href="/settings/bambu" className="underline">
              connect your Bambu account
            </Link>
            . Otherwise download the .3mf in your browser and upload it — the metadata is read from the file automatically. <br />
            MakerWorld collections (makerworld.com/…/collections/…): every model in the
            collection imports in the background into a new collection here — requires a
            connected Bambu account; progress shows in the top-right corner. <br />
            Onshape: paste a document link (cad.onshape.com/documents/…) to export its tabs as{" "}
            <code>.3mf</code> files — requires{" "}
            <Link href="/settings/onshape" className="underline">
              signing in with your Onshape account
            </Link>
            .
          </p>
        </form>
      </CardContent>
    </Card>

      <AlertDialog
        open={pendingConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setPendingConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Import all files?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingConfirm ? (
                <>
                  “{pendingConfirm.title}” contains a lot of files (
                  {pendingConfirm.fileCount} model files). Downloading them all
                  can take a while. Continue?
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmImport}>Continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
