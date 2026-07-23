"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Box, Boxes, CloudDownload, HelpCircle } from "lucide-react";
import { IMPORT_DRAFT_KEY } from "@/app/models/import-draft";
import { IMPORT_TYPES, type ImportType } from "./import-types";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

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

// The "What gets imported?" reference, split per source so each import type
// shows only its relevant sources (see HELP_SECTIONS_BY_TYPE).
const HELP_SECTIONS: Record<string, React.ReactNode> = {
  printables: (
    <section className="grid gap-1.5">
      <h3 className="font-medium">Printables</h3>
      <p className="text-muted-foreground">
        Metadata, images and model files import directly — no connected account
        needed.
      </p>
    </section>
  ),
  makerworld: (
    <section className="grid gap-1.5">
      <h3 className="font-medium">MakerWorld</h3>
      <p className="text-muted-foreground">
        Metadata and images always import. The <code>.3mf</code> files import
        too once you{" "}
        <Link href="/settings/bambu" className="underline">
          connect your Bambu account
        </Link>
        . Without a connection, download the <code>.3mf</code> yourself and
        upload it instead — the metadata is read from the file automatically.
      </p>
    </section>
  ),
  collection: (
    <section className="grid gap-1.5">
      <h3 className="font-medium">MakerWorld collections</h3>
      <p className="text-muted-foreground">
        A <code>makerworld.com/…/collections/…</code> link imports every model
        in the collection in the background, into a new collection here.
        Requires a connected Bambu account; progress shows in the top-right
        corner.
      </p>
    </section>
  ),
  onshape: (
    <>
      <section className="grid gap-1.5">
        <h3 className="font-medium">Onshape</h3>
        <p className="text-muted-foreground">
          Paste a document link (<code>cad.onshape.com/documents/…</code>), pick
          the Part Studio/Assembly tabs to import, and each exports as its own{" "}
          <code>.3mf</code> file. Requires{" "}
          <Link href="/settings/onshape" className="underline">
            signing in with your Onshape account
          </Link>
          .
        </p>
      </section>
      <section className="grid gap-1.5">
        <p className="text-muted-foreground">
          To keep several parameterizations of one design, put each on its own
          branch or version (choose it in the import dialog) and import them as
          separate models — or derive configured Part Studios into separate
          tabs. Editing Variable Studio values in place between imports
          doesn&apos;t stick: the next sync re-exports the branch&apos;s current
          state.
        </p>
      </section>
    </>
  ),
};

const HELP_SECTIONS_BY_TYPE: Record<ImportType, string[]> = {
  model: ["printables", "makerworld"],
  collection: ["collection"],
  cad: ["onshape"],
};

export function ImportForm({ type }: { type: ImportType }) {
  const config = IMPORT_TYPES[type];
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
      // The import type is chosen up front in the sidebar, so route by it
      // directly rather than sniffing the URL for a collection link.
      if (type === "collection") {
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
            <div className="flex items-center justify-between">
              <Label htmlFor="url">{config.inputLabel}</Label>
              <Dialog>
                <DialogTrigger asChild>
                  <Button type="button" variant="ghost" size="xs">
                    <HelpCircle className="size-3.5" />
                    What gets imported?
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-xl">
                  <DialogHeader>
                    <DialogTitle>{config.heading}</DialogTitle>
                    <DialogDescription>
                      What&apos;s imported, and what a connected account adds.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-5 text-sm">
                    {HELP_SECTIONS_BY_TYPE[type].map((key) => (
                      <Fragment key={key}>{HELP_SECTIONS[key]}</Fragment>
                    ))}
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            <Input
              id="url"
              name="url"
              type="url"
              required
              placeholder={config.placeholder}
              disabled={fetching}
            />
          </div>
          <Button type="submit" disabled={fetching} className="justify-self-start">
            <CloudDownload className="size-4" />
            {fetching ? config.fetchingLabel : config.submitLabel}
          </Button>
          <p className="text-xs text-muted-foreground">{config.hint}</p>
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
