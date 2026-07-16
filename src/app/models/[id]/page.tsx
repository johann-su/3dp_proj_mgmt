import { notFound, redirect } from "next/navigation";
import { after } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { collectionModels, collections, models, modelVersions } from "@/db/schema";
import { buildSnapshot, summarizeVersionChange } from "@/lib/version-snapshot";
import { getSession } from "@/lib/auth";
import { canActAsOwner } from "@/lib/roles";
import { fileSrc, fileToken } from "@/lib/file-token";
import { get3mfSliceInfo } from "@/lib/threemf-remote";
import { processPendingSlices } from "@/lib/slicer";
import { incrementModelViewCount } from "@/lib/metrics";
import { readTextFile } from "@/lib/storage";
import { MAX_SCAD_SOURCE_BYTES, openscadConfigured } from "@/lib/openscad";
import { parseScadParameters } from "@/lib/scad-params";
import { fileExtension } from "@/lib/file-kind";
import { parseOnshapeUrl } from "@/lib/onshape/api";
import { platformFromSourceUrl } from "@/lib/platform";
import {
  ModelView,
  type ModelViewData,
  type CollectionOption,
  type PrintFileData,
} from "../model-view";
import type { ModelHistoryEntry } from "./history-panel";

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
  // The whole catalog is private — self-hosted instances store paid models.
  if (!session) redirect("/sign-in");
  // Trashed models are recoverable from /models/trash, not viewable.
  if (!model || model.deletedAt) notFound();

  after(() => incrementModelViewCount(model.id));

  // Edit history for the History panel: version rows in insertion order (the
  // identity id — rows written in one transaction share a created_at), each
  // summarized against its predecessor.
  const versionRows = await db.query.modelVersions.findMany({
    where: eq(modelVersions.modelId, model.id),
    orderBy: asc(modelVersions.id),
    with: { editor: { columns: { name: true } } },
  });
  // Models predating versioning have no rows until their first mutation
  // backfills one (ensureBaselineVersion). Until then, synthesize a display-
  // only v1 from the current state so History always shows the original
  // version — current, so no revert button, and nothing is written on GET.
  const history: ModelHistoryEntry[] =
    versionRows.length === 0
      ? [
          {
            versionId: 0,
            number: 1,
            createdAt: model.createdAt,
            editorName: model.user?.name ?? null,
            reason: "create",
            summary: summarizeVersionChange(null, buildSnapshot(model)),
            current: true,
          },
        ]
      : versionRows
          .map((v, i) => ({
            versionId: v.id,
            number: i + 1,
            createdAt: v.createdAt,
            editorName: v.editor?.name ?? null,
            reason: v.reason,
            summary: summarizeVersionChange(
              versionRows[i - 1]?.snapshot ?? null,
              v.snapshot,
            ),
            current: i === versionRows.length - 1,
          }))
          .reverse();

  const images = model.files.filter((f) => f.kind === "image");
  const printFiles = model.files.filter((f) => f.kind === "model");
  const pdfFiles = model.files.filter((f) => f.kind === "pdf");
  // Owner-equivalent for the destructive bits (delete the model, delete any
  // variant): the owner themselves or a moderator/admin.
  const canManage = canActAsOwner(session.user, model.userId);
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
  const sliceInfoByFileId = new Map(
    printFiles.map((f, index) => [f.id, sliceInfos[index]]),
  );

  // Parametric .scad files: parse the customizer schema from the source so
  // any signed-in viewer gets the parameter form (customizing is open to
  // non-owners too). Only worth the S3 read when the OpenSCAD service is
  // configured and the viewer could actually render.
  const scadConfigured = openscadConfigured();
  const scadGroupsByFileId = new Map<
    string,
    ReturnType<typeof parseScadParameters>
  >();
  if (scadConfigured) {
    const scadFiles = printFiles.filter(
      (f) => fileExtension(f.filename) === ".scad",
    );
    await Promise.all(
      scadFiles.map(async (f) => {
        const source = await readTextFile(f.s3Key, f.size, MAX_SCAD_SOURCE_BYTES);
        if (source) scadGroupsByFileId.set(f.id, parseScadParameters(source));
      }),
    );
  }

  // Files can be left pending when the slicer service was unreachable (or
  // unconfigured) at upload time — retry them in the background so estimates
  // eventually appear on refresh.
  const slicerConfigured = !!process.env.SLICER_URL;
  if (slicerConfigured && printFiles.some((f) => f.sliceStatus === "pending")) {
    after(() => processPendingSlices(model.id));
  }

  let collectionOptions: CollectionOption[] = [];
  if (session) {
    // Smart collections are excluded: their membership is rule-defined, so
    // there is nothing to add a model to (see toggleModelInCollection).
    const own = await db.query.collections.findMany({
      where: and(eq(collections.userId, session.user.id), eq(collections.smart, false)),
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
    parametric: printFiles.some((f) => fileExtension(f.filename) === ".scad"),
    sourceUrl: model.sourceUrl ?? null,
    sourceName,
    onshapeWvm,
    makerworldUrl,
    images: images.map((img) => ({ src: fileSrc(img.id) })),
    // Every stored .3mf can be previewed interactively in the gallery; .step
    // and .scad geometry can't be rendered client-side, so they're excluded.
    modelFiles: printFiles
      .filter((f) => f.filename.toLowerCase().endsWith(".3mf"))
      .map((f) => ({ filename: f.filename, src: fileSrc(f.id) })),
    bom: model.bomItems,
    printFiles: (() => {
      const toEntry = (file: (typeof printFiles)[number]): PrintFileData => {
        const info = sliceInfoByFileId.get(file.id);
        const persisted = file.sliceStatus === "ok";
        const approx = persisted && file.sliceSource === "slicer";
        return {
          id: file.id,
          filename: file.filename,
          // Signed access token for the slicer deep links, which download the
          // file without the session cookie (see file-download-menu.tsx).
          downloadToken: fileToken(file.id),
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
          paramsSummary: file.generatedParams
            ? Object.entries(file.generatedParams)
                .map(([key, value]) => `${key} = ${value}`)
                .join(", ") || "default parameters"
            : null,
          // Owner and moderators/admins may delete any variant; anyone else
          // only the ones they generated (generatedBy). Matches the DELETE
          // route's check.
          deletableByViewer:
            canManage || file.generatedBy === session.user.id,
        };
      };
      // Generated .3mf variants render nested under their .scad source
      // instead of cluttering the top-level file list.
      return printFiles
        .filter((f) => f.generatedFromId === null)
        .map((file) => ({
          ...toEntry(file),
          customizer: scadGroupsByFileId.get(file.id) ?? null,
          variants: printFiles
            .filter((f) => f.generatedFromId === file.id)
            .map(toEntry),
        }));
    })(),
    pdfFiles: pdfFiles.map((file) => ({
      id: file.id,
      filename: file.filename,
      size: file.size,
    })),
    modelId: model.id,
    canManage,
    isLoggedIn: !!session,
    collectionOptions,
    slicerConfigured,
    history,
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <ModelView data={data} />
    </div>
  );
}
