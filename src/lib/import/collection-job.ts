// Background runner for MakerWorld collection imports. Started via
// next/server `after()` from POST /api/import/collection, so it survives the
// response but dies with the server process — the header indicator's poll
// (GET /api/import-jobs) marks heartbeat-stale jobs failed so they don't spin
// forever after a restart.
//
// Each listed design runs through the normal single-model import path
// (importFromMakerworld → stageImportedAssets) and is then inserted directly
// as a finished model — no create-form step, since editing dozens of models
// by hand is exactly what this feature avoids. Models land in the local
// collection created for the job as they finish. Designs the user already
// imported (same sourceUrl) are only linked into the collection, which also
// makes a re-run after a failure resume where it left off.

import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  bomItems,
  collectionModels,
  collections,
  importJobs,
  modelFiles,
  models,
} from "@/db/schema";
import { getBambuCredential } from "@/lib/bambu/credentials";
import { pickCategoryId } from "@/lib/categories";
import { sanitizeBomItems } from "@/lib/bom";
import { linkTags, normalizeTagNames } from "@/lib/tags";
import { sliceEligible, processPendingSlices } from "@/lib/slicer";
import { BAMBU_EXPIRED_WARNING, importFromMakerworld } from "./makerworld";
import {
  fetchMakerworldCollection,
  listMakerworldCollectionDesigns,
  parseMakerworldCollectionUrl,
  type MakerworldCollectionDesign,
} from "./makerworld-collection";
import { stageImportedAssets, type StagedImportFile } from "./stage";
import { animatedImageKeys } from "@/lib/storage";
import { ImportError, type ImportedProject } from "./types";

const MAX_WARNINGS = 50;
// Pause between designs — the whole job is one client hammering Bambu's API
// and CDN, so give them room to breathe.
const DELAY_BETWEEN_DESIGNS_MS = 500;

type JobRow = typeof importJobs.$inferSelect;

export type StartCollectionImport =
  | { ok: true; jobId: string; collectionId: string; title: string; total: number }
  | { ok: false; status: number; error: string };

// Validates and starts a collection import job, scheduling the runner via
// after(). With `existingCollectionId` (the "Sync" flow) new remote designs
// land in that collection instead of a freshly created one — the runner's
// dedup-by-sourceUrl turns the re-run into "import what's new, link the
// rest". Must be called from a request scope (route handler / server action)
// for after() to work.
export async function startCollectionImport(
  userId: string,
  url: URL,
  existingCollectionId?: string,
): Promise<StartCollectionImport> {
  const remoteId = parseMakerworldCollectionUrl(url);
  if (!remoteId) {
    return {
      ok: false,
      status: 400,
      error:
        "Not a MakerWorld collection URL (expected makerworld.com/…/collections/<id>)",
    };
  }

  // Bulk-importing metadata-only models (no .3mf) would leave dozens of
  // shells to fix by hand, so a connected Bambu account is required up front.
  const cred = await getBambuCredential(userId);
  if (!cred) {
    return {
      ok: false,
      status: 400,
      error:
        "Collection import downloads .3mf files, which needs a connected Bambu account — connect it in Settings → Bambu Cloud first",
    };
  }

  // One import at a time per user; a second job would fight the first for
  // Bambu API rate limits and make the progress indicator ambiguous.
  const running = await db.query.importJobs.findFirst({
    where: and(eq(importJobs.userId, userId), eq(importJobs.status, "running")),
    columns: { id: true },
  });
  if (running) {
    return {
      ok: false,
      status: 409,
      error: "Another import is already running — wait for it to finish",
    };
  }

  const remote = await fetchMakerworldCollection(remoteId, cred.region);
  if (remote.designCnt === 0) {
    return { ok: false, status: 400, error: "This collection is empty" };
  }

  const { job, collectionId } = await db.transaction(async (tx) => {
    let collectionId = existingCollectionId;
    if (!collectionId) {
      const [collection] = await tx
        .insert(collections)
        .values({
          title: remote.title,
          description: remote.description,
          userId,
          sourceUrl: url.toString(),
        })
        .returning({ id: collections.id });
      collectionId = collection.id;
    }
    const [job] = await tx
      .insert(importJobs)
      .values({
        userId,
        sourceUrl: url.toString(),
        collectionId,
        // Corrected to the listed (non-hidden) count once the runner starts.
        total: remote.designCnt,
      })
      .returning({ id: importJobs.id });
    return { job, collectionId };
  });

  after(() => runCollectionImportJob(job.id));

  return {
    ok: true,
    jobId: job.id,
    collectionId,
    title: remote.title,
    total: remote.designCnt,
  };
}

// Jobs currently running in this process (double-start guard, mirrors the
// inFlight set in src/lib/slicer.ts).
const inFlight = new Set<string>();

async function updateJob(jobId: string, values: Partial<JobRow>) {
  await db
    .update(importJobs)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(importJobs.id, jobId));
}

async function isCanceled(jobId: string): Promise<boolean> {
  const row = await db.query.importJobs.findFirst({
    where: eq(importJobs.id, jobId),
    columns: { status: true },
  });
  return !row || row.status === "canceled";
}

// Inserts an imported project as a finished model owned by the job's user and
// links it into the job's collection. Returns the new model id.
async function createImportedModel(
  userId: string,
  collectionId: string | null,
  project: ImportedProject,
  files: StagedImportFile[],
): Promise<string> {
  const tagNames = normalizeTagNames(project.tags);
  // Scraped BOM — sanitize (validates links, caps count) as createModel does.
  const bomResult = sanitizeBomItems(project.bom ?? []);
  const bom = "items" in bomResult ? bomResult.items : [];
  // Sniff image headers up front so animated covers freeze to a poster frame.
  const animatedKeys = await animatedImageKeys(files);
  // No form step to pick a category, so suggest one from MakerWorld's own
  // categories (plus tags/title); "Other" when nothing matches.
  const categoryId = await pickCategoryId({
    title: project.title,
    tags: project.tags,
    sourceCategories: project.categories,
  });
  return db.transaction(async (tx) => {
    const [model] = await tx
      .insert(models)
      .values({
        title: project.title,
        description: project.description.trim(),
        categoryId,
        userId,
        sourceUrl: project.sourceUrl,
      })
      .returning({ id: models.id });

    let position = 0;
    await tx.insert(modelFiles).values(
      files.map((file) => ({
        modelId: model.id,
        kind: file.kind,
        filename: file.filename,
        s3Key: file.key,
        size: file.size,
        contentType: file.contentType,
        animated: animatedKeys.has(file.key),
        position: position++,
        sliceStatus: sliceEligible(file.kind, file.filename)
          ? ("pending" as const)
          : null,
      })),
    );

    if (bom.length > 0) {
      await tx.insert(bomItems).values(
        bom.map((item, i) => ({
          modelId: model.id,
          name: item.name,
          quantity: item.quantity,
          link: item.link,
          imageUrl: item.imageUrl,
          section: item.section,
          position: i,
        })),
      );
    }

    await linkTags(tx, model.id, tagNames);

    if (collectionId) {
      await tx
        .insert(collectionModels)
        .values({ collectionId, modelId: model.id })
        .onConflictDoNothing();
    }

    return model.id;
  });
}

export async function runCollectionImportJob(jobId: string) {
  if (inFlight.has(jobId)) return;
  inFlight.add(jobId);
  try {
    await runJob(jobId);
  } catch (err) {
    console.error(`collection import ${jobId} failed:`, err);
    await updateJob(jobId, {
      status: "failed",
      currentItem: null,
      error:
        err instanceof ImportError
          ? err.message
          : "Import failed unexpectedly — check the server logs",
    }).catch(() => {});
  } finally {
    inFlight.delete(jobId);
  }
}

async function runJob(jobId: string) {
  const job = await db.query.importJobs.findFirst({
    where: eq(importJobs.id, jobId),
  });
  if (!job || job.status !== "running") return;

  // The start route requires a connected Bambu account; it can still have
  // been disconnected between then and now.
  const cred = await getBambuCredential(job.userId);
  if (!cred) {
    throw new ImportError(
      "Bambu Cloud account disconnected — reconnect it in Settings → Bambu Cloud",
    );
  }

  const collectionId = parseMakerworldCollectionUrl(new URL(job.sourceUrl));
  if (!collectionId) throw new ImportError("Not a MakerWorld collection URL");

  const designs = await listMakerworldCollectionDesigns(collectionId, cred.region);
  if (designs.length === 0) {
    throw new ImportError("The collection has no importable models");
  }

  const warnings: string[] = [];
  const warn = (message: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
    else if (warnings.length === MAX_WARNINGS) warnings.push("… more warnings omitted");
  };

  let completed = 0;
  let failed = 0;
  let skipped = 0;
  const createdModelIds: string[] = [];

  await updateJob(jobId, { total: designs.length });

  for (const design of designs) {
    if (await isCanceled(jobId)) return;
    await updateJob(jobId, { currentItem: design.title, completed, failed, skipped });

    try {
      const outcome = await importDesign(job, design, cred);
      if (outcome.kind === "created") createdModelIds.push(outcome.modelId);
      if (outcome.kind === "skipped") skipped++;
      if (outcome.kind === "failed") {
        failed++;
        warn(`${design.title}: ${outcome.reason}`);
      }
    } catch (err) {
      // An expired login fails every remaining download the same way — stop
      // instead of burning through the rest of the list.
      if (err instanceof ImportError && err.message === BAMBU_EXPIRED_WARNING) {
        throw err;
      }
      failed++;
      warn(
        `${design.title}: ${err instanceof ImportError ? err.message : "import failed"}`,
      );
      if (!(err instanceof ImportError)) {
        console.error(`collection import ${jobId}: design ${design.id} failed:`, err);
      }
    }

    completed++;
    await updateJob(jobId, { completed, failed, skipped, warnings });
    await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_DESIGNS_MS));
  }

  await updateJob(jobId, { status: "done", currentItem: null, warnings });

  // Estimate print time & filament sequentially once the job is done (most
  // MakerWorld profiles carry embedded slice_info, so this is usually just a
  // couple of ranged S3 reads per model). Kept out of the import loop so a
  // slow slicer service doesn't stretch the visible progress.
  for (const modelId of createdModelIds) {
    await processPendingSlices(modelId);
  }
}

type DesignOutcome =
  | { kind: "created"; modelId: string }
  | { kind: "skipped" }
  | { kind: "failed"; reason: string };

async function importDesign(
  job: JobRow,
  design: MakerworldCollectionDesign,
  cred: { token: string; region: "global" | "china" },
): Promise<DesignOutcome> {
  const sourceUrl = `https://makerworld.com/en/models/${design.id}`;

  // Already imported by this user → just make sure it's in the collection.
  const existing = await db.query.models.findFirst({
    where: and(eq(models.userId, job.userId), eq(models.sourceUrl, sourceUrl)),
    columns: { id: true },
  });
  if (existing) {
    if (job.collectionId) {
      await db
        .insert(collectionModels)
        .values({ collectionId: job.collectionId, modelId: existing.id })
        .onConflictDoNothing();
    }
    return { kind: "skipped" };
  }

  const project = await importFromMakerworld(new URL(sourceUrl), {
    token: cred.token,
    region: cred.region,
  });
  if (project.warnings.includes(BAMBU_EXPIRED_WARNING)) {
    throw new ImportError(BAMBU_EXPIRED_WARNING);
  }

  const staged = await stageImportedAssets(project);
  if (!staged.files.some((f) => f.kind === "model")) {
    const reason =
      [...project.warnings, ...staged.warnings][0] ?? "no .3mf could be downloaded";
    return { kind: "failed", reason };
  }

  const modelId = await createImportedModel(
    job.userId,
    job.collectionId,
    project,
    staged.files,
  );
  return { kind: "created", modelId };
}
