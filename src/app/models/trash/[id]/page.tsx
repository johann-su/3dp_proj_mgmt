import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { Trash2 } from "lucide-react";
import { db } from "@/db";
import { models } from "@/db/schema";
import { getSession, signInRedirect } from "@/lib/auth";
import { canActAsOwner } from "@/lib/roles";
import { fileSrc } from "@/lib/file-token";
import { resolveBedSizeMm } from "@/lib/printer-beds";
import { get3mfSliceInfo } from "@/lib/threemf-remote";
import { fileExtension } from "@/lib/file-kind";
import { formatDate } from "@/lib/format";
import { platformFromSourceUrl } from "@/lib/platform";
import { TRASH_RETENTION_DAYS } from "@/lib/model-versions";
import { ModelView, type ModelViewData, type PrintFileData } from "../../model-view";
import { TrashPreviewActions } from "./trash-preview-actions";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Whole days until the lazy sweep purges a trashed model for good (same as the
// trash list; kept local to avoid coupling the two pages).
function daysUntilPurge(deletedAt: Date): number {
  const purgeAt =
    deletedAt.getTime() + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((purgeAt - Date.now()) / (24 * 60 * 60 * 1000)));
}

// Read-only preview of a trashed model, so it can be inspected before restoring
// or purging — the model page itself notFounds trashed models. Soft delete only
// sets deleted_at, so the live model_files rows still serve their bytes; this
// renders the same ModelView as the model page, fed from those live rows, with
// every mutating affordance disabled via modelId: null (edit, collections,
// sync, customize, per-file/variant delete, history) and only Restore / Delete
// permanently / Back as actions. Access is scoped like the trash list: the
// owner, or a moderator/admin (canActAsOwner) — a plain user can't peek at
// someone else's trashed model, and we notFound rather than leak its existence.
export default async function TrashPreviewPage({
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
        files: { orderBy: (f, { asc: ascOp }) => ascOp(f.position) },
        modelTags: { with: { tag: true } },
        bomItems: { orderBy: (b, { asc: ascOp }) => ascOp(b.position) },
      },
    }),
    getSession(),
  ]);
  if (!session) redirect(await signInRedirect());
  // Only trashed models live here; a live model is viewed at /models/[id].
  if (!model || !model.deletedAt) notFound();
  // Scoped like the trash list itself — owner or moderator/admin only.
  if (!canActAsOwner(session.user, model.userId)) notFound();

  const images = model.files.filter((f) => f.kind === "image");
  const printFiles = model.files.filter((f) => f.kind === "model");
  const pdfFiles = model.files.filter((f) => f.kind === "pdf");

  // Same estimate sourcing as the model page: embedded Bambu slice_info read
  // live from S3 (ranged GETs), falling back to the persisted values.
  const sliceInfos = await Promise.all(
    printFiles.map((f) => get3mfSliceInfo(f.s3Key, f.size)),
  );
  const sliceInfoByFileId = new Map(
    printFiles.map((f, index) => [f.id, sliceInfos[index]]),
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

  const toEntry = (file: (typeof printFiles)[number]): PrintFileData => {
    const info = sliceInfoByFileId.get(file.id);
    const persisted = file.sliceStatus === "ok";
    return {
      id: null,
      downloadToken: null,
      src: fileSrc(file.id),
      filename: file.filename,
      imported: file.imported,
      size: file.size,
      printTime:
        info?.printTimeSeconds ??
        (persisted ? file.printTimeSeconds : null) ??
        null,
      grams:
        info?.filamentGrams ?? (persisted ? file.filamentGrams : null) ?? null,
      approx: persisted && file.sliceSource === "slicer",
      plateCount: info?.plateCount ?? null,
      printer: file.printerInfo ?? null,
      // Never show the "estimating…" pulse in a read-only preview — pending
      // rows never advance here (nothing re-runs the slicer for trash).
      sliceStatus: file.sliceStatus === "failed" ? "failed" : null,
      sliceError: file.sliceError ?? null,
      paramsSummary: file.generatedParams
        ? Object.entries(file.generatedParams)
            .map(([key, value]) => `${key} = ${value}`)
            .join(", ") || "default parameters"
        : null,
    };
  };

  const data: ModelViewData = {
    title: model.title,
    description: model.description,
    author: model.user.name,
    createdAt: model.createdAt,
    category: model.category ? { name: model.category.name } : null,
    tags: model.modelTags.map(({ tag }) => ({ name: tag.name })),
    platform: platformFromSourceUrl(model.sourceUrl),
    parametric: printFiles.some((f) => fileExtension(f.filename) === ".scad"),
    sourceUrl: model.sourceUrl ?? null,
    sourceName,
    // Suppress sync rows — syncing a trashed model makes no sense, and both
    // gates already require modelId anyway.
    onshapeWvm: null,
    makerworldUrl: null,
    images: images.map((img) => ({ src: fileSrc(img.id) })),
    modelFiles: printFiles
      .filter((f) => f.filename.toLowerCase().endsWith(".3mf"))
      .map((f) => ({
        filename: f.filename,
        src: fileSrc(f.id),
        bed: resolveBedSizeMm(f.printerInfo),
      })),
    bom: model.bomItems,
    // Generated variants nest under their .scad source, like the model page —
    // they come back with the model on restore, so a preview should show them.
    printFiles: printFiles
      .filter((f) => f.generatedFromId === null)
      .map((file) => ({
        ...toEntry(file),
        customizer: null,
        variants: printFiles
          .filter((f) => f.generatedFromId === file.id)
          .map(toEntry),
      })),
    pdfFiles: pdfFiles.map((file) => ({
      id: null,
      src: fileSrc(file.id),
      filename: file.filename,
      size: file.size,
    })),
    // null disables every mutating affordance in ModelView — read-only preview.
    modelId: null,
    canManage: false,
    isLoggedIn: false,
    collectionOptions: [],
    slicerConfigured: false,
  };

  const daysLeft = daysUntilPurge(model.deletedAt);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Trash2 className="size-5 text-muted-foreground" />
            In trash
          </h1>
          <p className="text-sm text-muted-foreground">
            Deleted {formatDate(model.deletedAt)} · purged in {daysLeft} day
            {daysLeft === 1 ? "" : "s"} — a read-only preview, not a live model.
          </p>
        </div>
        <TrashPreviewActions modelId={model.id} title={model.title} />
      </div>

      <div className="rounded-lg border border-dashed p-4 sm:p-6">
        <ModelView data={data} />
      </div>
    </div>
  );
}
