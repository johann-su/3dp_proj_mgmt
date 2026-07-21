"use client";

// The model page layout: gallery + description on the left, metadata, file
// cards (model-file-cards.tsx) and actions on the right. Shared by the model
// page, the read-only version preview and the create-wizard preview — every
// mutating affordance is disabled by `modelId: null`.

import Link from "next/link";
import { ExternalLink, Pencil, SquarePen } from "lucide-react";
import type { SourcePlatform } from "@/lib/platform";
import { platformLabels } from "@/lib/platform";
import { formatDate } from "@/lib/format";
import type { BomItemInput } from "@/lib/bom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ImageGallery } from "@/components/image-gallery";
import { Markdown } from "@/components/markdown";
import { ShareButton } from "@/components/share-button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { BomSection } from "./bom-section";
import {
  DocumentsCard,
  PrintFilesCard,
  type PdfFileData,
  type PrintFileData,
} from "./model-file-cards";
import { AddToCollection, type CollectionOption } from "./[id]/add-to-collection";
import { DeleteModelButton } from "./[id]/delete-model-button";
import { HistoryPanel, type ModelHistoryEntry } from "./[id]/history-panel";
import { OnshapeSyncButton } from "./[id]/onshape-sync-button";
import { SourceSyncButton } from "./[id]/source-sync-button";

export type { CollectionOption };
export type { PdfFileData, PrintFileData } from "./model-file-cards";

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
  pdfFiles: PdfFileData[];
  modelId: string | null;
  // Viewer may delete the model and any variant: the owner or a
  // moderator/admin (see canActAsOwner).
  canManage: boolean;
  isLoggedIn: boolean;
  collectionOptions: CollectionOption[];
  slicerConfigured: boolean;
  // Edit history, newest first (absent in the create-wizard preview).
  history?: ModelHistoryEntry[];
};

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
    canManage,
    isLoggedIn,
    collectionOptions,
    slicerConfigured,
    history,
  } = data;

  return (
    // On mobile the columns fold into a single flow reordered with `order`:
    // header first (order-1), then the gallery (order-2), then the description
    // that trails it, then the downloads (order-3). On `lg` the two grid
    // columns take over and `order-none` restores document order.
    <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[1fr_400px]">
      <div className="order-2 min-w-0 lg:order-none">
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

      {/* The right column on `lg`. On mobile it dissolves (display:contents)
          so its two blocks become siblings of the gallery: the metadata
          header floats above it (order-1) and the downloads below the
          description (order-3). */}
      <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-4">
        <div className="order-1 min-w-0 space-y-4 lg:order-none">
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
              {isLoggedIn &&
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

          {(platform === "makerworld" || platform === "printables") &&
            isLoggedIn &&
            modelId &&
            sourceName && (
              <div className="flex flex-wrap items-center gap-2">
                <SourceSyncButton modelId={modelId} sourceName={sourceName} />
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
            <AddToCollection
              modelId={modelId}
              collections={collectionOptions}
            />
          )}
        </div>

        <div className="order-3 min-w-0 space-y-4 lg:order-none">
          <PrintFilesCard
            printFiles={printFiles}
            sourceName={sourceName}
            makerworldUrl={makerworldUrl}
            slicerConfigured={slicerConfigured}
            modelId={modelId}
          />

          {pdfFiles.length > 0 && <DocumentsCard pdfFiles={pdfFiles} />}

          {isLoggedIn && modelId && history && history.length > 0 && (
            <HistoryPanel modelId={modelId} entries={history} />
          )}

          {isLoggedIn && modelId && (
            <>
              <Separator />
              <div className="flex items-center gap-2">
                <ShareButton />
                <Button asChild variant="outline" size="sm">
                  <Link href={`/models/${modelId}/edit`}>
                    <Pencil className="size-4" />
                    Edit model
                  </Link>
                </Button>
                {/* Editing is open to all; deleting stays with the owner and
                    moderators/admins (canManage). */}
                {canManage && <DeleteModelButton modelId={modelId} />}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
