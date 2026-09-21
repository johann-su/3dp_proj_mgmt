import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { ArrowLeft, History } from "lucide-react";
import { db } from "@/db";
import { categories, models, modelVersions } from "@/db/schema";
import { getSession, signInRedirect } from "@/lib/auth";
import { versionFileSrc } from "@/lib/file-token";
import { resolveBedSizeMm } from "@/lib/printer-beds";
import { get3mfSliceInfo } from "@/lib/threemf-remote";
import { fileExtension } from "@/lib/file-kind";
import { formatDate } from "@/lib/format";
import { platformFromSourceUrl } from "@/lib/platform";
import { Button } from "@/components/ui/button";
import { ModelView, type ModelViewData } from "../../../model-view";
import { RestoreVersionButton } from "./restore-version-button";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Read-only preview of one version snapshot, so History entries can be
// inspected before restoring. Renders the same ModelView as the model page,
// but fed from the snapshot: files, images, PDFs, title/description, tags,
// category and BOM all show the version's state. Interactive affordances
// (edit, collections, sync, customize, per-file delete) are disabled by
// passing modelId: null — the only actions are Restore and Back. Historical
// bytes are served by /api/files/versions/[versionId]/[index]; the snapshot
// keeps every referenced S3 object alive, so previews work even for files
// that were later removed.
export default async function ModelVersionPreviewPage({
  params,
}: {
  params: Promise<{ id: string; versionId: string }>;
}) {
  const { id, versionId: rawVersionId } = await params;
  const versionId = Number(rawVersionId);
  if (!UUID_RE.test(id) || !Number.isSafeInteger(versionId) || versionId <= 0) {
    notFound();
  }

  const [model, session] = await Promise.all([
    db.query.models.findFirst({
      where: eq(models.id, id),
      with: { user: { columns: { name: true } } },
    }),
    getSession(),
  ]);
  if (!session) redirect(await signInRedirect());
  if (!model || model.deletedAt) notFound();

  const version = await db.query.modelVersions.findFirst({
    where: and(eq(modelVersions.id, versionId), eq(modelVersions.modelId, id)),
    with: { editor: { columns: { name: true } } },
  });
  if (!version) notFound();
  const snapshot = version.snapshot;

  // Version number = position in insertion order (identity ids — rows in one
  // transaction share created_at), same numbering as the History panel.
  const versionIds = await db
    .select({ id: modelVersions.id })
    .from(modelVersions)
    .where(eq(modelVersions.modelId, id))
    .orderBy(asc(modelVersions.id));
  const index = versionIds.findIndex((v) => v.id === versionId);
  const number = index + 1;
  const isCurrent = index === versionIds.length - 1;

  const category = snapshot.categoryId
    ? await db.query.categories.findFirst({
        where: eq(categories.id, snapshot.categoryId),
        columns: { name: true, slug: true },
      })
    : null;

  const files = snapshot.files.map((file, i) => ({
    ...file,
    src: versionFileSrc(versionId, i),
  }));
  const media = files.filter((f) => f.kind === "image" || f.kind === "video");
  const printFiles = files.filter((f) => f.kind === "model");
  const pdfFiles = files.filter((f) => f.kind === "pdf");

  // Same estimate sourcing as the model page: embedded Bambu slice_info read
  // live from S3 (ranged GETs), falling back to the values persisted in the
  // snapshot.
  const sliceInfos = await Promise.all(
    printFiles.map((f) => get3mfSliceInfo(f.s3Key, f.size)),
  );

  let sourceName: string | null = null;
  if (model.sourceUrl) {
    const platform = platformFromSourceUrl(model.sourceUrl);
    sourceName =
      platform === "makerworld"
        ? "MakerWorld"
        : platform === "printables"
          ? "Printables"
          : platform === "onshape"
            ? "Onshape"
            : null;
  }

  const data: ModelViewData = {
    title: snapshot.title,
    description: snapshot.description,
    author: model.user.name,
    createdAt: model.createdAt,
    category: category ? { name: category.name } : null,
    tags: snapshot.tags.map((name) => ({ name })),
    platform: platformFromSourceUrl(model.sourceUrl),
    parametric: printFiles.some((f) => fileExtension(f.filename) === ".scad"),
    sourceUrl: model.sourceUrl ?? null,
    sourceName,
    // Suppress the Onshape/source sync rows — syncing from inside a
    // historical preview would be confusing (it acts on the live model).
    onshapeWvm: null,
    makerworldUrl: null,
    media: media.map((f) => ({
      src: f.src,
      kind: f.kind === "video" ? ("video" as const) : ("image" as const),
    })),
    // Snapshots taken before gallery videos existed have no `videos` key.
    videos: snapshot.videos ?? [],
    modelFiles: printFiles
      .filter((f) => f.filename.toLowerCase().endsWith(".3mf"))
      .map((f) => ({
        filename: f.filename,
        src: f.src,
        bed: resolveBedSizeMm(f.printerInfo),
      })),
    bom: snapshot.bom,
    printFiles: printFiles.map((file, i) => {
      const info = sliceInfos[i];
      const persisted = file.sliceStatus === "ok";
      return {
        id: null,
        downloadToken: null,
        src: file.src,
        filename: file.filename,
        imported: file.imported ?? false,
        size: file.size,
        printTime:
          info?.printTimeSeconds ??
          (persisted ? file.printTimeSeconds : null) ??
          null,
        grams:
          info?.filamentGrams ?? (persisted ? file.filamentGrams : null) ?? null,
        approx: persisted && file.sliceSource === "slicer",
        plateCount: info?.plateCount ?? null,
        slicedPlateCount: info?.slicedPlateCount ?? null,
        printer: file.printerInfo ?? null,
        // Historic rows may say "pending" forever — never show the
        // "estimating…" pulse in a preview.
        sliceStatus: file.sliceStatus === "failed" ? "failed" : null,
        sliceError: file.sliceError ?? null,
      };
    }),
    pdfFiles: pdfFiles.map((file) => ({
      id: null,
      src: file.src,
      filename: file.filename,
      size: file.size,
    })),
    // null disables every mutating affordance in ModelView (collections,
    // sync, customize, delete, history) — this page is read-only.
    modelId: null,
    canManage: false,
    isLoggedIn: false,
    collectionOptions: [],
    slicerConfigured: false,
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <History className="size-5 text-muted-foreground" />
            Version {number}
            {isCurrent ? " (current)" : ""}
          </h1>
          <p className="text-sm text-muted-foreground">
            Saved {formatDate(version.createdAt)}
            {version.editor?.name ? ` by ${version.editor.name}` : ""} — a
            read-only snapshot, not the current state of the model.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/models/${model.id}`}>
              <ArrowLeft className="size-4" />
              Back to model
            </Link>
          </Button>
          {!isCurrent && (
            <RestoreVersionButton
              modelId={model.id}
              versionId={versionId}
              number={number}
            />
          )}
        </div>
      </div>

      <div className="rounded-lg border border-dashed p-4 sm:p-6">
        <ModelView data={data} />
      </div>
    </div>
  );
}
