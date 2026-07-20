"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Box, Boxes, CloudDownload } from "lucide-react";
import { IMPORT_DRAFT_KEY } from "@/app/models/import-draft";
import type { OnshapeBranchPick, OnshapeImportTab } from "@/lib/import/onshape";
import type { OnshapeBranchChoice } from "@/lib/onshape/api";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

// Default tab selection, following Onshape's workflow: Part Studios hold the
// printable geometry (preselected); Assemblies only position parts, so their
// exports overlap when sliced (deselected). Assembly-only documents fall back
// to the linked tab, then to everything.
function defaultOnshapeSelection(tabs: OnshapeImportTab[], maxTabs: number): string[] {
  let preselected = tabs.filter((t) => t.elementType === "PARTSTUDIO");
  if (preselected.length === 0) {
    const pinned = tabs.filter((t) => t.pinned);
    preselected = pinned.length > 0 ? pinned : tabs;
  }
  return preselected.slice(0, maxTabs).map((t) => t.id);
}

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
  // Set when an Onshape document has several tabs or branches/versions —
  // drives the tab-selection dialog (see defaultOnshapeSelection for the
  // preselect rules). `selected` is the branch/version the tab list was read
  // from; picking another in the dropdown re-requests the listing.
  const [pendingOnshape, setPendingOnshape] = useState<{
    url: string;
    title: string;
    tabs: OnshapeImportTab[];
    maxTabs: number;
    branches: OnshapeBranchChoice[];
    selected: OnshapeBranchPick;
  } | null>(null);
  const [onshapeSelected, setOnshapeSelected] = useState<string[]>([]);
  // Branch switch in flight — freezes the dialog's controls until the new
  // tab list arrives.
  const [onshapeSwitching, setOnshapeSwitching] = useState(false);

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

  async function importModel(
    url: string,
    opts: {
      confirm?: boolean;
      onshapeElements?: string[];
      onshapeBranch?: OnshapeBranchPick;
    } = {},
  ) {
    const res = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        confirm: opts.confirm ?? false,
        // Absent on the first POST — for multi-tab Onshape documents the
        // route then answers with the tab list instead of importing.
        onshapeElements: opts.onshapeElements,
        // The dialog's branch/version pick; overrides the URL's /w|v/ pin.
        onshapeWvm: opts.onshapeBranch?.wvm,
        onshapeWvmId: opts.onshapeBranch?.wvmId,
      }),
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
    // Multi-tab or multi-branch Onshape document — open (or, on a branch
    // switch, refresh) the tab-selection dialog.
    if (body?.needsOnshapeSelection) {
      const tabs: OnshapeImportTab[] = Array.isArray(body.tabs) ? body.tabs : [];
      const maxTabs = typeof body.maxTabs === "number" ? body.maxTabs : 8;
      setFetching(false);
      setOnshapeSelected(defaultOnshapeSelection(tabs, maxTabs));
      setPendingOnshape({
        url,
        title: body.title ?? "",
        tabs,
        maxTabs,
        branches: Array.isArray(body.branches) ? body.branches : [],
        selected: body.selected ?? { wvm: "w", wvmId: "" },
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
      await importModel(url, { confirm: true });
    } catch (err) {
      setFetching(false);
      toast.error(err instanceof Error ? err.message : "Import failed");
    }
  }

  async function confirmOnshapeImport() {
    if (!pendingOnshape || onshapeSelected.length === 0) return;
    const { url, selected } = pendingOnshape;
    const onshapeElements = onshapeSelected;
    setPendingOnshape(null);
    setFetching(true);
    try {
      await importModel(url, { onshapeElements, onshapeBranch: selected });
    } catch (err) {
      setFetching(false);
      toast.error(err instanceof Error ? err.message : "Import failed");
    }
  }

  // Re-requests the tab listing for the picked branch/version; the response
  // is always another selection payload (the dropdown only renders when the
  // document has more than one branch choice), which refreshes the dialog.
  async function switchOnshapeBranch(value: string) {
    if (!pendingOnshape || onshapeSwitching) return;
    const choice = pendingOnshape.branches.find((b) => `${b.wvm}:${b.id}` === value);
    if (!choice || (choice.wvm === pendingOnshape.selected.wvm && choice.id === pendingOnshape.selected.wvmId)) {
      return;
    }
    setOnshapeSwitching(true);
    try {
      await importModel(pendingOnshape.url, {
        onshapeBranch: { wvm: choice.wvm, wvmId: choice.id },
      });
    } catch (err) {
      // Keep the dialog on the previous branch; the select snaps back since
      // its value derives from pendingOnshape.selected.
      toast.error(err instanceof Error ? err.message : "Couldn't load that branch");
    } finally {
      setOnshapeSwitching(false);
    }
  }

  function toggleOnshapeTab(id: string, checked: boolean) {
    setOnshapeSelected((prev) =>
      checked ? [...prev, id] : prev.filter((tabId) => tabId !== id),
    );
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
            Onshape: paste a document link (cad.onshape.com/documents/…), pick the
            Part Studio/Assembly tabs to import, and each exports as its own{" "}
            <code>.3mf</code> file — requires{" "}
            <Link href="/settings/onshape" className="underline">
              signing in with your Onshape account
            </Link>
            . <br />
            Parametric Onshape documents: to keep several parameterizations of one
            design, put each on its own branch or version (choose it in the import
            dialog) and import them as separate models — or derive configured Part
            Studios into separate tabs. Editing Variable Studio values in place
            between imports doesn&apos;t stick: the next sync re-exports the
            branch&apos;s current state.
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

      <AlertDialog
        open={pendingOnshape !== null}
        onOpenChange={(open) => {
          if (!open) setPendingOnshape(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Choose Onshape tabs to import</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingOnshape ? (
                <>
                  Each selected tab of “{pendingOnshape.title}” is exported as
                  its own <code>.3mf</code> file. Part Studios contain the
                  printable parts; Assemblies export their parts in assembled
                  positions, so interlocking parts overlap when sliced.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingOnshape && pendingOnshape.branches.length > 1 ? (
            <Select
              value={`${pendingOnshape.selected.wvm}:${pendingOnshape.selected.wvmId}`}
              onValueChange={switchOnshapeBranch}
              disabled={onshapeSwitching}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["w", "v"] as const).map((wvm) => {
                  const group = pendingOnshape.branches.filter((b) => b.wvm === wvm);
                  if (group.length === 0) return null;
                  return (
                    <SelectGroup key={wvm}>
                      <SelectLabel>{wvm === "w" ? "Branches" : "Versions"}</SelectLabel>
                      {group.map((b) => (
                        <SelectItem key={b.id} value={`${b.wvm}:${b.id}`}>
                          {b.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  );
                })}
              </SelectContent>
            </Select>
          ) : null}
          {pendingOnshape && pendingOnshape.tabs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This branch has no Part Studio or Assembly tabs.
            </p>
          ) : null}
          {pendingOnshape && pendingOnshape.tabs.length > 0 ? (
            <div
              className={`grid gap-3 max-h-72 overflow-y-auto pr-1 ${onshapeSwitching ? "opacity-50 pointer-events-none" : ""}`}
            >
              {(["PARTSTUDIO", "ASSEMBLY"] as const).map((elementType) => {
                const group = pendingOnshape.tabs.filter(
                  (tab) => tab.elementType === elementType,
                );
                if (group.length === 0) return null;
                const full = onshapeSelected.length >= pendingOnshape.maxTabs;
                return (
                  <div key={elementType} className="grid gap-1.5">
                    <p className="text-xs font-medium text-muted-foreground">
                      {elementType === "PARTSTUDIO" ? "Part Studios" : "Assemblies"}
                    </p>
                    {group.map((tab) => {
                      const checked = onshapeSelected.includes(tab.id);
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
                            onChange={(e) => toggleOnshapeTab(tab.id, e.target.checked)}
                          />
                          {elementType === "PARTSTUDIO" ? (
                            <Box className="size-4 shrink-0 text-muted-foreground" />
                          ) : (
                            <Boxes className="size-4 shrink-0 text-muted-foreground" />
                          )}
                          <span className="flex-1 truncate text-sm">{tab.name}</span>
                          {tab.pinned && (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              linked tab
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                );
              })}
              <p className="text-xs text-muted-foreground">
                Up to {pendingOnshape.maxTabs} tabs per import.
              </p>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmOnshapeImport}
              disabled={onshapeSelected.length === 0 || onshapeSwitching}
            >
              Import{" "}
              {onshapeSelected.length === 1
                ? "1 tab"
                : `${onshapeSelected.length} tabs`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
