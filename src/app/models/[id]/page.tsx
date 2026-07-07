import Link from "next/link";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  Clock,
  Download,
  ExternalLink,
  FileBox,
  FileText,
  Layers,
  Pencil,
  Printer,
  SquarePen,
  TriangleAlert,
  Weight,
} from "lucide-react";
import { db } from "@/db";
import { collectionModels, collections, models } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { formatBytes, formatDate, formatDuration, formatGrams } from "@/lib/format";
import { get3mfSliceInfo } from "@/lib/threemf-remote";
import { processPendingSlices } from "@/lib/slicer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ImageGallery } from "@/components/image-gallery";
import { parseOnshapeUrl } from "@/lib/onshape/api";
import { platformFromSourceUrl, platformLabels } from "@/lib/platform";
import { Markdown } from "@/components/markdown";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { BomSection } from "./bom-section";
import { DeleteModelButton } from "./delete-model-button";
import { AddToCollection, type CollectionOption } from "./add-to-collection";
import { OpenInSlicer } from "./open-in-slicer";
import { OnshapeSyncButton } from "./onshape-sync-button";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ModelPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const [model, session] = await Promise.all([
    db.query.models.findFirst({
      where: eq(models.id, id),
      with: {
        user: { columns: { name: true } },
        category: true,
        files: { orderBy: (f, { asc }) => asc(f.position) },
        modelTags: { with: { tag: true } },
        bomItems: { orderBy: (b, { asc }) => asc(b.position) },
      },
    }),
    getSession(),
  ]);
  if (!model) notFound();

  const images = model.files.filter((f) => f.kind === "image");
  const printFiles = model.files.filter((f) => f.kind === "model");
  const pdfFiles = model.files.filter((f) => f.kind === "pdf");
  const isOwner = session?.user.id === model.userId;
  const platform = platformFromSourceUrl(model.sourceUrl);
  const makerworldUrl = model.sourceUrl?.includes("makerworld")
    ? model.sourceUrl
    : undefined;

  let sourceName: string | undefined;
  let onshapePin: ReturnType<typeof parseOnshapeUrl> = null;
  if (model.sourceUrl) {
    try {
      const source = new URL(model.sourceUrl);
      onshapePin = parseOnshapeUrl(source);
      sourceName = onshapePin
        ? "Onshape"
        : source.hostname.includes("makerworld")
          ? "MakerWorld"
          : "Printables";
    } catch {
      // malformed sourceUrl — omit the source link
    }
  }

  const sliceInfos = await Promise.all(
    printFiles.map((f) => get3mfSliceInfo(f.s3Key, f.size)),
  );

  // Files can be left pending when the slicer service was unreachable (or
  // unconfigured) at upload time — retry them in the background so estimates
  // eventually appear on refresh.
  const slicerConfigured = !!process.env.SLICER_URL;
  if (slicerConfigured && printFiles.some((f) => f.sliceStatus === "pending")) {
    after(() => processPendingSlices(model.id));
  }

  let collectionOptions: CollectionOption[] = [];
  if (session) {
    const own = await db.query.collections.findMany({
      where: eq(collections.userId, session.user.id),
      orderBy: asc(collections.title),
      columns: { id: true, title: true },
    });
    const memberships = own.length
      ? await db
          .select({ collectionId: collectionModels.collectionId })
          .from(collectionModels)
          .where(
            and(
              eq(collectionModels.modelId, model.id),
              inArray(
                collectionModels.collectionId,
                own.map((c) => c.id),
              ),
            ),
          )
      : [];
    const memberIds = new Set(memberships.map((m) => m.collectionId));
    collectionOptions = own.map((c) => ({
      id: c.id,
      title: c.title,
      inCollection: memberIds.has(c.id),
    }));
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="grid gap-8 lg:grid-cols-[1fr_400px]">
        <div className="min-w-0">
          <ImageGallery
            images={images.map((img) => ({ src: `/api/files/${img.id}` }))}
            title={model.title}
            badge={
              platform && (
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
              )
            }
          />

          {model.bomItems.length > 0 && (
            <BomSection modelId={model.id} items={model.bomItems} />
          )}

          <div className="mt-8">
            <h2 className="text-lg font-semibold mb-2">Description</h2>
            {model.description ? (
              <Markdown>{model.description}</Markdown>
            ) : (
              <p className="text-sm text-muted-foreground">No description.</p>
            )}
          </div>
        </div>

        <div className="min-w-0 space-y-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight break-words">
              {model.title}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              by {model.user.name} · {formatDate(model.createdAt)}
            </p>
            {model.sourceUrl && sourceName && (
              <a
                href={model.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline mt-1"
              >
                <ExternalLink className="size-3.5" />
                Imported from {sourceName}
              </a>
            )}
          </div>

          {onshapePin && model.sourceUrl && (
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <a
                  href={model.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <SquarePen className="size-4" />
                  Edit in Onshape
                </a>
              </Button>
              {isOwner &&
                (onshapePin.wvm === "v" ? (
                  <span className="text-xs text-muted-foreground">
                    Pinned to an Onshape version
                  </span>
                ) : (
                  <OnshapeSyncButton modelId={model.id} />
                ))}
            </div>
          )}

          <div className="flex flex-wrap gap-1.5">
            {model.category && (
              <Link href={`/?category=${model.category.slug}`}>
                <Badge>{model.category.name}</Badge>
              </Link>
            )}
            {model.modelTags.map(({ tag }) => (
              <Link key={tag.id} href={`/?q=${encodeURIComponent(tag.name)}`}>
                <Badge variant="secondary">{tag.name}</Badge>
              </Link>
            ))}
          </div>

          {session && (
            <AddToCollection modelId={model.id} collections={collectionOptions} />
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Files ({printFiles.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {printFiles.map((file, index) => {
                const info = sliceInfos[index];
                // Embedded Bambu predictions (live or persisted) take priority;
                // values from the headless slicer's generic profile are
                // approximations and marked with "~".
                const persisted = file.sliceStatus === "ok";
                const approx = persisted && file.sliceSource === "slicer";
                const printTime =
                  info?.printTimeSeconds ??
                  (persisted ? file.printTimeSeconds : null);
                const grams =
                  info?.filamentGrams ?? (persisted ? file.filamentGrams : null);
                // Hardware the project was set up for (see PrinterInfo).
                const printer = file.printerInfo;
                return (
                  <div
                    key={file.id}
                    className="flex min-w-0 items-center gap-3 border rounded-lg px-3 py-2.5"
                  >
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
                      <FileBox className="size-5 text-muted-foreground/80" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="text-sm font-medium truncate">
                        {file.filename}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        {printTime != null && (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="size-3.5" />
                            {approx ? "~" : ""}
                            {formatDuration(printTime)}
                          </span>
                        )}
                        {grams != null && (
                          <span className="inline-flex items-center gap-1">
                            <Weight className="size-3.5" />
                            {approx ? "~" : ""}
                            {formatGrams(grams)}
                          </span>
                        )}
                        {info && (
                          <span className="inline-flex items-center gap-1">
                            <Layers className="size-3.5" />
                            {info.plateCount}{" "}
                            {info.plateCount === 1 ? "plate" : "plates"}
                          </span>
                        )}
                        <span>{formatBytes(file.size)}</span>
                        {file.sliceStatus === "pending" && slicerConfigured && (
                          <span className="animate-pulse">estimating…</span>
                        )}
                      </div>
                      {(printer || file.sliceStatus === "failed") && (
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          {printer?.model && (
                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                              <Printer className="size-3.5" />
                              {printer.model}
                              {printer.nozzleDiameterMm != null &&
                                ` · ${printer.nozzleDiameterMm} mm`}
                            </span>
                          )}
                          {printer?.filamentTypes?.map((type) => (
                            <Badge
                              key={type}
                              variant="secondary"
                              className="px-1.5 py-0 text-[10px] font-medium"
                            >
                              {type}
                            </Badge>
                          ))}
                          {printer?.bedType && (
                            <Badge
                              variant="outline"
                              className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
                            >
                              {printer.bedType.toLowerCase()}
                            </Badge>
                          )}
                          {file.sliceStatus === "failed" && (
                            <span
                              className="inline-flex items-center gap-1 text-xs text-destructive"
                              title={file.sliceError ?? undefined}
                            >
                              <TriangleAlert className="size-3.5" />
                              Couldn&apos;t be sliced — the file may not be
                              printable
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <OpenInSlicer
                        fileId={file.id}
                        makerworldUrl={makerworldUrl}
                      />
                      <Button
                        asChild
                        size="icon"
                        variant="ghost"
                        aria-label={`Download ${file.filename}`}
                      >
                        <a href={`/api/files/${file.id}?download=1`}>
                          <Download className="size-4" />
                        </a>
                      </Button>
                    </div>
                  </div>
                );
              })}
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
                {pdfFiles.map((file) => (
                  <div
                    key={file.id}
                    className="flex min-w-0 items-center gap-3 border rounded-md px-3 py-2"
                  >
                    <FileText className="size-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <a
                        href={`/api/files/${file.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-sm font-medium truncate hover:underline"
                      >
                        {file.filename}
                      </a>
                      <div className="text-xs text-muted-foreground">
                        {formatBytes(file.size)}
                      </div>
                    </div>
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
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {isOwner && (
            <>
              <Separator />
              <div className="flex items-center gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link href={`/models/${model.id}/edit`}>
                    <Pencil className="size-4" />
                    Edit model
                  </Link>
                </Button>
                <DeleteModelButton modelId={model.id} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
