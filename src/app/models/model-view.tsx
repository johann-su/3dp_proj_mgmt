"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Clock,
  Download,
  ExternalLink,
  FileBox,
  FileText,
  HardDrive,
  Layers,
  Loader2,
  Pencil,
  Printer,
  SquarePen,
  Trash2,
  TriangleAlert,
  Weight,
} from "lucide-react";
import type { PrinterInfo } from "@/db/schema";
import type { ScadParameterGroup } from "@/lib/scad-params";
import type { SourcePlatform } from "@/lib/platform";
import { platformLabels } from "@/lib/platform";
import { formatBytes, formatDate, formatDuration, formatGrams } from "@/lib/format";
import type { BomItemInput } from "@/lib/bom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ImageGallery } from "@/components/image-gallery";
import { Markdown } from "@/components/markdown";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { BomSection } from "./bom-section";
import { AddToCollection, type CollectionOption } from "./[id]/add-to-collection";
import { DeleteModelButton } from "./[id]/delete-model-button";
import { OnshapeSyncButton } from "./[id]/onshape-sync-button";
import { FileDownloadMenu } from "./[id]/file-download-menu";

export type { CollectionOption };

export type PrintFileData = {
  id: string | null;
  filename: string;
  // Signed /api/files access token for slicer deep links (null in the
  // create-wizard preview, where the file has no id yet either).
  downloadToken: string | null;
  size: number;
  printTime: number | null;
  grams: number | null;
  approx: boolean;
  plateCount: number | null;
  printer: PrinterInfo | null;
  sliceStatus: string | null;
  sliceError: string | null;
  // Parametric .scad files: customizer schema parsed from the source (only
  // set when the owner can render, i.e. OPENSCAD_URL is configured), plus the
  // .3mf variants generated from this file.
  customizer?: ScadParameterGroup[] | null;
  variants?: PrintFileData[];
  // On a generated variant: the customizer values it was rendered with.
  paramsSummary?: string | null;
};

export type ModelViewData = {
  title: string;
  description: string;
  author: string;
  createdAt: Date;
  category: { name: string; slug?: string } | null;
  tags: Array<{ id?: string; name: string }>;
  platform: SourcePlatform | null;
  // True when the model ships a `.scad` source (customizable via OpenSCAD).
  parametric: boolean;
  sourceUrl: string | null;
  sourceName: string | null;
  onshapeWvm: string | null;
  makerworldUrl: string | null;
  images: Array<{ src: string }>;
  // Previewable .3mf files for the gallery's interactive 3D view (issue #35).
  modelFiles: Array<{ filename: string; src: string }>;
  bom: BomItemInput[];
  printFiles: PrintFileData[];
  pdfFiles: Array<{
    id: string | null;
    filename: string;
    size: number;
  }>;
  modelId: string | null;
  isOwner: boolean;
  isLoggedIn: boolean;
  collectionOptions: CollectionOption[];
  slicerConfigured: boolean;
};

// Owner-only delete for a generated .3mf variant — they're cheap to
// regenerate, so no confirmation dialog.
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
  );
}

function PrintFileRow({
  file,
  makerworldUrl,
  slicerConfigured,
  deletable,
}: {
  file: PrintFileData;
  makerworldUrl: string | null;
  slicerConfigured: boolean;
  deletable?: { modelId: string };
}) {
  // Slicer deep links only make sense for .3mf files — Bambu Studio hard-
  // rejects any other filename ("unknown file format") and Orca would save a
  // useless download. Other model files (.scad, .step) get a plain download.
  const is3mf = file.filename.toLowerCase().endsWith(".3mf");

  return (
    <div className="flex min-w-0 items-center gap-3 border rounded-lg px-3 py-2.5">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
        <FileBox className="size-5 text-muted-foreground/80" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-sm font-medium truncate">{file.filename}</div>
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
        {(file.printer?.filamentTypes?.length ||
          file.printer?.bedType ||
          file.sliceStatus === "failed") && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {file.printer?.filamentTypes?.map((type) => (
              <Badge
                key={type}
                variant="secondary"
                className="px-1.5 py-0 text-[10px] font-medium"
              >
                {type}
              </Badge>
            ))}
            {file.printer?.bedType && (
              <Badge
                variant="outline"
                className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
              >
                {file.printer.bedType.toLowerCase()}
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
        ) : file.id ? (
          <Button
            asChild
            size="icon"
            variant="outline"
            aria-label={`Download ${file.filename}`}
          >
            <a href={`/api/files/${file.id}?download=1`}>
              <Download className="size-4" />
            </a>
          </Button>
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

export function ModelView({ data }: { data: ModelViewData }) {
  const {
    title,
    description,
    author,
    createdAt,
    category,
    tags,
    platform,
    parametric,
    sourceUrl,
    sourceName,
    onshapeWvm,
    makerworldUrl,
    images,
    modelFiles,
    bom,
    printFiles,
    pdfFiles,
    modelId,
    isOwner,
    isLoggedIn,
    collectionOptions,
    slicerConfigured,
  } = data;

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_400px]">
      <div className="min-w-0">
        <ImageGallery
          images={images}
          title={title}
          modelFiles={modelFiles}
          badge={
            (platform || parametric) && (
              <div className="flex flex-col gap-2">
                {platform && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex size-8 items-center justify-center rounded-lg bg-white/90 p-1.5 shadow-sm ring-1 ring-black/5 backdrop-blur">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/logos/${platform}.svg`}
                          alt={`${platformLabels[platform]} logo`}
                          className="size-full object-contain"
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      {platformLabels[platform]}
                    </TooltipContent>
                  </Tooltip>
                )}
                {parametric && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex size-8 items-center justify-center rounded-lg bg-primary p-1 shadow-sm ring-1 ring-black/5 backdrop-blur">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src="/customize.svg"
                          alt="Parametric model"
                          className="size-full object-contain"
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      Customizable OpenSCAD model
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            )
          }
        />

        {bom.length > 0 && (
          <BomSection
            items={bom}
            downloadUrl={modelId ? `/api/models/${modelId}/bom` : undefined}
            interactive={modelId !== null}
          />
        )}

        <div className="mt-8">
          <h2 className="text-lg font-semibold mb-2">Description</h2>
          {description ? (
            <Markdown>{description}</Markdown>
          ) : (
            <p className="text-sm text-muted-foreground">No description.</p>
          )}
        </div>
      </div>

      <div className="min-w-0 space-y-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight break-words">
            {title || "Untitled model"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            by {author} · {formatDate(createdAt)}
          </p>
          {sourceUrl && sourceName && (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline mt-1"
            >
              <ExternalLink className="size-3.5" />
              Imported from {sourceName}
            </a>
          )}
        </div>

        {onshapeWvm !== null && sourceUrl && (
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
                <SquarePen className="size-4" />
                Edit in Onshape
              </a>
            </Button>
            {isOwner &&
              modelId &&
              (onshapeWvm === "v" ? (
                <span className="text-xs text-muted-foreground">
                  Pinned to an Onshape version
                </span>
              ) : (
                <OnshapeSyncButton modelId={modelId} />
              ))}
          </div>
        )}

        {(category || tags.length > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {category &&
              (category.slug ? (
                <Link href={`/?category=${category.slug}`}>
                  <Badge>{category.name}</Badge>
                </Link>
              ) : (
                <Badge>{category.name}</Badge>
              ))}
            {tags.map((tag) =>
              tag.id ? (
                <Link
                  key={tag.id}
                  href={`/?q=${encodeURIComponent(tag.name)}`}
                >
                  <Badge variant="secondary">{tag.name}</Badge>
                </Link>
              ) : (
                <Badge key={tag.name} variant="secondary">
                  {tag.name}
                </Badge>
              ),
            )}
          </div>
        )}

        {isLoggedIn && modelId && (
          <AddToCollection modelId={modelId} collections={collectionOptions} />
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Files (
              {printFiles.reduce((n, f) => n + 1 + (f.variants?.length ?? 0), 0)}
              )
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {printFiles.map((file, index) => (
              <div key={file.id ?? `${file.filename}-${index}`} className="grid gap-2">
                <PrintFileRow
                  file={file}
                  makerworldUrl={makerworldUrl}
                  slicerConfigured={slicerConfigured}
                />
                {file.customizer &&
                  file.customizer.length > 0 &&
                  isOwner &&
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
                        makerworldUrl={makerworldUrl}
                        slicerConfigured={slicerConfigured}
                        deletable={isOwner && modelId ? { modelId } : undefined}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        {pdfFiles.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Documents ({pdfFiles.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {pdfFiles.map((file, index) => (
                <div
                  key={file.id ?? `${file.filename}-${index}`}
                  className="flex min-w-0 items-center gap-3 border rounded-md px-3 py-2"
                >
                  <FileText className="size-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    {file.id ? (
                      <a
                        href={`/api/files/${file.id}`}
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
                  {file.id ? (
                    <Button
                      asChild
                      size="icon"
                      variant="ghost"
                      className="ml-auto shrink-0"
                      aria-label={`Download ${file.filename}`}
                    >
                      <a href={`/api/files/${file.id}?download=1`}>
                        <Download className="size-4" />
                      </a>
                    </Button>
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
              ))}
            </CardContent>
          </Card>
        )}

        {isOwner && modelId && (
          <>
            <Separator />
            <div className="flex items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href={`/models/${modelId}/edit`}>
                  <Pencil className="size-4" />
                  Edit model
                </Link>
              </Button>
              <DeleteModelButton modelId={modelId} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
