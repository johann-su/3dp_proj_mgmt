import { eq } from "drizzle-orm";
import { db } from "@/db";
import { models } from "@/db/schema";
import { resolveBedSizeMm } from "@/lib/printer-beds";
import { get3mfSliceInfo } from "@/lib/threemf-remote";
import { fileExtension } from "@/lib/file-kind";
import { platformFromSourceUrl } from "@/lib/platform";
import { parseOnshapeUrl } from "@/lib/onshape/api";
import { sharedFileSrc } from "@/lib/share-token";
import type { ModelViewData, PrintFileData } from "@/app/models/model-view";

// The anonymous projection of a model for the public share pages. Built as an
// allowlist rather than by reusing the member page's loader: anything not
// copied in here never reaches someone without an account. Deliberately left
// out — edit history and editor names, likes/pins/collections, customizer
// schemas (rendering needs the session-gated API), and BOM item images (they
// go through the session-gated /api/bom-image fetch proxy, which must not be
// opened to anonymous callers). Every file URL is share-scoped
// (sharedFileSrc) so it dies with the link; `modelId: null` makes ModelView
// drop every mutating affordance, as in the version preview.
//
// The caller must already have checked that the share grants this model.
export async function loadSharedModelView(
  token: string,
  modelId: string,
): Promise<ModelViewData | null> {
  const model = await db.query.models.findFirst({
    where: eq(models.id, modelId),
    with: {
      user: { columns: { name: true } },
      category: true,
      files: { orderBy: (f, { asc }) => asc(f.position) },
      modelTags: { with: { tag: true } },
      bomItems: { orderBy: (b, { asc }) => asc(b.position) },
    },
  });
  if (!model || model.deletedAt) return null;

  const src = (fileId: string) => sharedFileSrc(token, fileId);
  const media = model.files.filter((f) => f.kind === "image" || f.kind === "video");
  const printFiles = model.files.filter((f) => f.kind === "model");
  const pdfFiles = model.files.filter((f) => f.kind === "pdf");

  let sourceName: string | null = null;
  let onshapeWvm: string | null = null;
  if (model.sourceUrl) {
    try {
      const source = new URL(model.sourceUrl);
      const onshapePin = parseOnshapeUrl(source);
      onshapeWvm = onshapePin?.wvm ?? null;
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
  const sliceInfoByFileId = new Map(printFiles.map((f, i) => [f.id, sliceInfos[i]]));

  const toEntry = (file: (typeof printFiles)[number]): PrintFileData => {
    const info = sliceInfoByFileId.get(file.id);
    const persisted = file.sliceStatus === "ok";
    return {
      // No id/downloadToken: the row then downloads from `src` (plain link,
      // no slicer deep links — those need the file-token URL).
      id: null,
      downloadToken: null,
      src: src(file.id),
      filename: file.filename,
      imported: file.imported,
      size: file.size,
      printTime: info?.printTimeSeconds ?? (persisted ? file.printTimeSeconds : null) ?? null,
      grams: info?.filamentGrams ?? (persisted ? file.filamentGrams : null) ?? null,
      approx: persisted && file.sliceSource === "slicer",
      plateCount: info?.plateCount ?? null,
      printer: file.printerInfo ?? null,
      sliceStatus: file.sliceStatus ?? null,
      sliceError: null,
      paramsSummary: file.generatedParams
        ? Object.entries(file.generatedParams)
            .map(([key, value]) => `${key} = ${value}`)
            .join(", ") || "default parameters"
        : null,
    };
  };

  return {
    title: model.title,
    description: model.description,
    author: model.user.name,
    createdAt: model.createdAt,
    // No slug/ids: category and tag badges would link into the private
    // catalog, so they render as plain badges.
    category: model.category ? { name: model.category.name } : null,
    tags: model.modelTags.map(({ tag }) => ({ name: tag.name })),
    platform: platformFromSourceUrl(model.sourceUrl),
    parametric: printFiles.some((f) => fileExtension(f.filename) === ".scad"),
    sourceUrl: model.sourceUrl ?? null,
    sourceName,
    onshapeWvm,
    makerworldUrl: model.sourceUrl?.includes("makerworld") ? model.sourceUrl : null,
    media: media.map((f) => ({
      src: src(f.id),
      kind: f.kind === "video" ? ("video" as const) : ("image" as const),
    })),
    videos: model.videos,
    modelFiles: printFiles
      .filter((f) => f.filename.toLowerCase().endsWith(".3mf"))
      .map((f) => ({
        filename: f.filename,
        src: src(f.id),
        bed: resolveBedSizeMm(f.printerInfo),
      })),
    bom: model.bomItems.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      link: item.link,
      imageUrl: null,
      section: item.section,
    })),
    printFiles: printFiles
      .filter((f) => f.generatedFromId === null)
      .map((file) => ({
        ...toEntry(file),
        variants: printFiles.filter((f) => f.generatedFromId === file.id).map(toEntry),
      })),
    pdfFiles: pdfFiles.map((file) => ({
      id: null,
      filename: file.filename,
      size: file.size,
      src: src(file.id),
    })),
    modelId: null,
    canManage: false,
    isLoggedIn: false,
    collectionOptions: [],
    slicerConfigured: false,
  };
}
