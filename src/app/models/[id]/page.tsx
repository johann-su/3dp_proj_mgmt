import { notFound } from "next/navigation";
import { after } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { collectionModels, collections, models } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { get3mfSliceInfo } from "@/lib/threemf-remote";
import { processPendingSlices } from "@/lib/slicer";
import { parseOnshapeUrl } from "@/lib/onshape/api";
import { platformFromSourceUrl } from "@/lib/platform";
import { ModelView, type ModelViewData, type CollectionOption } from "../model-view";

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
    : null;

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

  const data: ModelViewData = {
    title: model.title,
    description: model.description,
    author: model.user.name,
    createdAt: model.createdAt,
    category: model.category
      ? { name: model.category.name, slug: model.category.slug }
      : null,
    tags: model.modelTags.map(({ tag }) => ({ id: tag.id, name: tag.name })),
    platform,
    sourceUrl: model.sourceUrl ?? null,
    sourceName,
    onshapeWvm,
    makerworldUrl,
    images: images.map((img) => ({ src: `/api/files/${img.id}` })),
    bom: model.bomItems,
    printFiles: printFiles.map((file, index) => {
      const info = sliceInfos[index];
      const persisted = file.sliceStatus === "ok";
      const approx = persisted && file.sliceSource === "slicer";
      return {
        id: file.id,
        filename: file.filename,
        size: file.size,
        printTime:
          info?.printTimeSeconds ??
          (persisted ? file.printTimeSeconds : null) ??
          null,
        grams:
          info?.filamentGrams ??
          (persisted ? file.filamentGrams : null) ??
          null,
        approx,
        plateCount: info?.plateCount ?? null,
        printer: file.printerInfo ?? null,
        sliceStatus: file.sliceStatus ?? null,
        sliceError: file.sliceError ?? null,
      };
    }),
    pdfFiles: pdfFiles.map((file) => ({
      id: file.id,
      filename: file.filename,
      size: file.size,
    })),
    modelId: model.id,
    isOwner,
    isLoggedIn: !!session,
    collectionOptions,
    slicerConfigured,
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <ModelView data={data} />
    </div>
  );
}
