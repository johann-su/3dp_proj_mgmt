"use client";

// The model page's collapsible "Files" and "Documents" cards: print-file rows
// with slice estimates, per-file customize/variant affordances and slicer
// deep links, plus the PDF list. Rendered by ModelView (model-view.tsx).

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronDown,
  Clock,
  CloudDownload,
  Download,
  FileBox,
  FileText,
  HardDrive,
  Layers,
  Loader2,
  Printer,
  Trash2,
  TriangleAlert,
  Weight,
} from "lucide-react";
import type { PrinterInfo } from "@/db/schema";
import type { ScadParameterGroup } from "@/lib/scad-params";
import { formatBytes, formatDuration, formatGrams } from "@/lib/format";
import { filamentSummary } from "@/lib/printer-info";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FileDownloadMenu } from "./[id]/file-download-menu";

export type PrintFileData = {
  id: string | null;
  filename: string;
  // The file came with the model's source-platform import (or Onshape sync)
  // rather than being uploaded by hand — badged with a cloud icon.
  imported: boolean;
  // Signed /api/files access token for slicer deep links (null in the
  // create-wizard preview, where the file has no id yet either).
  downloadToken: string | null;
  // Download URL for files without a live model_files row — the version
  // preview serves historical files via /api/files/versions/… (already
  // token-authenticated, so extra query params are appended with "&").
  src?: string | null;
  size: number;
  printTime: number | null;
  grams: number | null;
  approx: boolean;
  plateCount: number | null;
  printer: PrinterInfo | null;
  sliceStatus: string | null;
  sliceError: string | null;
  // Parametric .scad files: customizer schema parsed from the source (set for
  // any signed-in viewer when OPENSCAD_URL is configured), plus the .3mf
  // variants generated from this file.
  customizer?: ScadParameterGroup[] | null;
  variants?: PrintFileData[];
  // On a generated variant: the customizer values it was rendered with.
  paramsSummary?: string | null;
  // On a generated variant: whether the current viewer may delete it (the
  // model owner may delete any variant; anyone else only those they generated).
  deletableByViewer?: boolean;
};

export type PdfFileData = {
  id: string | null;
  filename: string;
  size: number;
  // Like PrintFileData.src: serves the PDF when there is no live row
  // (version preview).
  src?: string | null;
};

// Delete for a generated .3mf variant — shown to the model owner (any variant)
// and to whoever generated it. Cheap to regenerate, so no confirmation dialog.
function DeleteVariantButton({
  modelId,
  fileId,
  filename,
}: {
  modelId: string;
  fileId: string;
  filename: string;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/models/${modelId}/customize`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `Delete failed (${res.status})`);
      toast.success(`Deleted “${filename}”.`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          disabled={deleting}
          onClick={handleDelete}
          aria-label={`Delete ${filename}`}
        >
          {deleting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Trash2 className="size-4 text-muted-foreground" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Delete variant</TooltipContent>
    </Tooltip>
  );
}

function PrintFileRow({
  file,
  sourceName,
  makerworldUrl,
  slicerConfigured,
  deletable,
}: {
  file: PrintFileData;
  // Platform label for the imported badge's tooltip ("MakerWorld", …).
  sourceName: string | null;
  makerworldUrl: string | null;
  slicerConfigured: boolean;
  deletable?: { modelId: string };
}) {
  // Slicer deep links only make sense for .3mf files — Bambu Studio hard-
  // rejects any other filename ("unknown file format") and Orca would save a
  // useless download. Other model files (.scad, .step) get a plain download.
  const is3mf = file.filename.toLowerCase().endsWith(".3mf");
  const filaments = filamentSummary(file.printer);

  return (
    <div className="flex min-w-0 items-center gap-3 border rounded-lg px-3 py-2.5">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
        <FileBox className="size-5 text-muted-foreground/80" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-sm font-medium truncate">{file.filename}</span>
          {file.imported && (
            <Tooltip>
              <TooltipTrigger asChild>
                <CloudDownload
                  className="size-3.5 shrink-0 text-primary"
                  aria-label={`Imported from ${sourceName ?? "the source platform"}`}
                />
              </TooltipTrigger>
              <TooltipContent>
                Imported from {sourceName ?? "the source platform"}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {file.paramsSummary && (
          <div className="text-xs text-muted-foreground truncate">
            {file.paramsSummary}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {file.printTime != null && (
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
              <Clock className="size-4 text-primary" />
              {file.approx ? "~" : ""}
              {formatDuration(file.printTime)}
            </span>
          )}
          {file.grams != null && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Weight className="size-3.5 text-chart-3" />
              {file.approx ? "~" : ""}
              {formatGrams(file.grams)}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {file.plateCount != null && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Layers className="size-3.5 text-chart-2" />
              {file.plateCount} {file.plateCount === 1 ? "plate" : "plates"}
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <HardDrive className="size-3.5" />
            {formatBytes(file.size)}
          </span>
          {file.sliceStatus === "pending" && slicerConfigured && (
            <span className="text-xs text-muted-foreground animate-pulse">
              estimating…
            </span>
          )}
        </div>
        {file.printer?.model && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Printer className="size-3.5" />
              {file.printer.model}
              {file.printer.nozzleDiameterMm != null &&
                ` · ${file.printer.nozzleDiameterMm} mm`}
            </span>
          </div>
        )}
        {(filaments ||
          file.printer?.bedType ||
          file.printer?.usesSupport ||
          file.sliceStatus === "failed") && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {/* One badge per filament slot — the same material twice means a
                two-colour print, so these are intentionally not deduped. */}
            {filaments?.slots.map((slot, i) => (
              <Badge
                key={`${i}-${slot.type}`}
                variant="secondary"
                className="px-1.5 py-0 text-[10px] font-medium"
              >
                {slot.color && (
                  <span
                    className="size-2 shrink-0 rounded-full border border-foreground/20"
                    style={{ backgroundColor: slot.color }}
                  />
                )}
                {slot.type}
              </Badge>
            ))}
            {/* Like "supports": only the informative case is badged. */}
            {filaments?.multi && (
              <Badge
                variant="outline"
                className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
              >
                {filaments.multi === "material" ? "multi-material" : "multi-color"}
              </Badge>
            )}
            {file.printer?.requiresMultiNozzle && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
                  >
                    multi-nozzle
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  Needs a printer with more than one nozzle (toolchanger or dual
                  extruder) — an AMS/MMU won&apos;t do
                </TooltipContent>
              </Tooltip>
            )}
            {file.printer?.bedType && (
              <Badge
                variant="outline"
                className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
              >
                {file.printer.bedType.toLowerCase()}
              </Badge>
            )}
            {/* Only the positive case is worth a badge: "no supports" is the
                default expectation, and the setting is often simply unknown. */}
            {file.printer?.usesSupport && (
              <Badge
                variant="outline"
                className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
              >
                supports
              </Badge>
            )}
            {file.sliceStatus === "failed" && (
              <span
                className="inline-flex items-center gap-1 text-xs text-destructive"
                title={file.sliceError ?? undefined}
              >
                <TriangleAlert className="size-3.5" />
                Couldn&apos;t be sliced — the file may not be printable
              </span>
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center">
        {deletable && file.id && (
          <DeleteVariantButton
            modelId={deletable.modelId}
            fileId={file.id}
            filename={file.filename}
          />
        )}
        {file.id && file.downloadToken && is3mf ? (
          <FileDownloadMenu
            fileId={file.id}
            token={file.downloadToken}
            filename={file.filename}
            makerworldUrl={makerworldUrl ?? undefined}
          />
        ) : file.id || file.src ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                asChild
                size="icon"
                variant="outline"
                aria-label={`Download ${file.filename}`}
              >
                <a
                  href={
                    file.id
                      ? `/api/files/${file.id}?download=1`
                      : `${file.src}&download=1`
                  }
                >
                  <Download className="size-4" />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Download</TooltipContent>
          </Tooltip>
        ) : (
          <Button
            size="icon"
            variant="outline"
            disabled
            aria-label={`Download ${file.filename}`}
          >
            <Download className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

export function PrintFilesCard({
  printFiles,
  sourceName,
  makerworldUrl,
  slicerConfigured,
  modelId,
}: {
  printFiles: PrintFileData[];
  sourceName: string | null;
  makerworldUrl: string | null;
  slicerConfigured: boolean;
  // Null in the create-wizard preview and version preview, which disables
  // the customize link and variant deletion.
  modelId: string | null;
}) {
  const [open, setOpen] = useState(true);

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <Card>
        <CardHeader>
          <CollapsibleTrigger className="group -m-2 flex w-full items-center gap-2 rounded-md p-2 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronDown
              className={cn(
                "size-4 text-muted-foreground transition-transform",
                !open && "-rotate-90",
              )}
            />
            <FileBox className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">
              Files (
              {printFiles.reduce(
                (n, f) => n + 1 + (f.variants?.length ?? 0),
                0,
              )}
              )
            </CardTitle>
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="grid gap-2">
            {printFiles.map((file, index) => (
              <div key={file.id ?? `${file.filename}-${index}`} className="grid gap-2">
                <PrintFileRow
                  file={file}
                  sourceName={sourceName}
                  makerworldUrl={makerworldUrl}
                  slicerConfigured={slicerConfigured}
                />
                {file.customizer &&
                  file.customizer.length > 0 &&
                  modelId &&
                  file.id && (
                    <Button asChild size="lg">
                      <Link href={`/models/${modelId}/customize/${file.id}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src="/customize.svg"
                          alt=""
                          className="size-6 dark:invert-0 invert"
                        />
                        Customize
                      </Link>
                    </Button>
                  )}
                {file.variants && file.variants.length > 0 && (
                  <div className="grid gap-2 border-l-2 pl-3 ml-1">
                    {file.variants.map((variant) => (
                      <PrintFileRow
                        key={variant.id ?? variant.filename}
                        file={variant}
                        sourceName={sourceName}
                        makerworldUrl={makerworldUrl}
                        slicerConfigured={slicerConfigured}
                        deletable={
                          variant.deletableByViewer && modelId
                            ? { modelId }
                            : undefined
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

export function DocumentsCard({ pdfFiles }: { pdfFiles: PdfFileData[] }) {
  const [open, setOpen] = useState(true);

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <Card>
        <CardHeader>
          <CollapsibleTrigger className="group -m-2 flex w-full items-center gap-2 rounded-md p-2 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronDown
              className={cn(
                "size-4 text-muted-foreground transition-transform",
                !open && "-rotate-90",
              )}
            />
            <FileText className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">
              Documents ({pdfFiles.length})
            </CardTitle>
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="grid gap-2">
            {pdfFiles.map((file, index) => {
              const viewHref = file.id
                ? `/api/files/${file.id}`
                : (file.src ?? null);
              const downloadHref = file.id
                ? `/api/files/${file.id}?download=1`
                : file.src
                  ? `${file.src}&download=1`
                  : null;
              return (
                <div
                  key={file.id ?? `${file.filename}-${index}`}
                  className="flex min-w-0 items-center gap-3 border rounded-md px-3 py-2"
                >
                  <FileText className="size-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    {viewHref ? (
                      <a
                        href={viewHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-sm font-medium truncate hover:underline"
                      >
                        {file.filename}
                      </a>
                    ) : (
                      <div className="text-sm font-medium truncate">
                        {file.filename}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground">
                      {formatBytes(file.size)}
                    </div>
                  </div>
                  {downloadHref ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          asChild
                          size="icon"
                          variant="ghost"
                          className="ml-auto shrink-0"
                          aria-label={`Download ${file.filename}`}
                        >
                          <a href={downloadHref}>
                            <Download className="size-4" />
                          </a>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Download</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="ml-auto shrink-0"
                      disabled
                      aria-label={`Download ${file.filename}`}
                    >
                      <Download className="size-4" />
                    </Button>
                  )}
                </div>
              );
            })}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
