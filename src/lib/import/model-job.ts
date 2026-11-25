// Background runner for single-model imports: the import page's "Import in background" button next to "Fetch model". It shares the collection job's import_jobs row, its after() scheduling and the header indicator (see collection-job.ts), but for one URL, and it ends differently. Instead of a hand-rolled insert, the staged files go through createModelRecord, the same write path the create form's save uses, so versioning, duplicate recording, slicing and revalidation match a foreground import. The user reviews the finished model rather than a draft.
//
// "Unattended" shapes the rules: the many-files prompt is skipped (nobody is waiting on the download), a source that would need a dialog (Onshape's tab picker) fails the job with a pointer to the regular import, and so does a draft without any model file, since there is no form to add one in. The design-level duplicate prompt is the exception: it's a cheap DB lookup, so it runs before the job starts and the client asks it like the foreground import does.

import { after } from "next/server";
import { db } from "@/db";
import { importJobs } from "@/db/schema";
import { pickCategoryId } from "@/lib/categories";
import { findDuplicatesForUrl, type DuplicateMatch } from "@/lib/duplicates";
import { createModelRecord } from "@/lib/model-mutations";
import { deleteS3Keys } from "@/lib/model-versions";
import { importerForUrl, importRejection } from "@/lib/sources/importers";
import { supportedSourcesSentence } from "@/lib/sources/registry";
import { reportError } from "@/lib/telemetry";
import { eq } from "drizzle-orm";
import { stageImportedAssets } from "./stage";
import { ImportError } from "./types";
import {
  IMPORT_ALREADY_RUNNING,
  hasRunningImport,
  isImportJobCanceled,
  updateImportJob,
} from "./jobs";

export type StartModelImport =
  | { ok: true; jobId: string }
  | { ok: false; status: number; error: string }
  // The catalog already holds this design and the user hasn't answered the prompt yet. Nothing was started.
  | { ok: false; duplicates: DuplicateMatch[] };

// Validates the URL and schedules the runner via after(), so it must be called from a request scope (route handler / server action). Everything checked here is cheap. The platform calls and downloads all happen in the job.
export async function startModelImport(
  userId: string,
  url: URL,
  opts: { confirmDuplicate: boolean },
): Promise<StartModelImport> {
  const importer = importerForUrl(url);
  if (!importer) {
    return {
      ok: false,
      status: 400,
      error:
        importRejection(url) ??
        `Unsupported URL — paste a ${supportedSourcesSentence()} link`,
    };
  }

  const blocker = await importer.backgroundBlocker?.(userId);
  if (blocker) return { ok: false, status: 400, error: blocker };

  if (await hasRunningImport(userId)) {
    return { ok: false, status: 409, error: IMPORT_ALREADY_RUNNING };
  }

  // Same flag-only check as POST /api/import, asked before the job starts so the answer can still come from the user.
  const duplicates = await findDuplicatesForUrl(url);
  if (duplicates.length > 0 && !opts.confirmDuplicate) {
    return { ok: false, duplicates };
  }

  const [job] = await db
    .insert(importJobs)
    .values({ userId, kind: "model", sourceUrl: url.toString(), total: 1 })
    .returning({ id: importJobs.id });

  // The matches the user waved through travel in the closure rather than on the row. A job never outlives its process anyway, because a restart fails it via the heartbeat.
  const duplicateOfIds = duplicates.map((d) => d.id);
  after(() => runModelImportJob(job.id, duplicateOfIds));

  return { ok: true, jobId: job.id };
}

// The collection runner heartbeats once per design. This one spends nearly all its time inside a single stageImportedAssets call (a parametric MakerWorld design can carry ~100 print profiles), so it beats on a timer instead. Otherwise the stall check in GET /api/import-jobs would fail a long download that is still making progress.
const HEARTBEAT_MS = 60_000;

export async function runModelImportJob(jobId: string, duplicateOfIds: string[]) {
  const heartbeat = setInterval(() => {
    updateImportJob(jobId, {}).catch(() => {});
  }, HEARTBEAT_MS);
  try {
    await runJob(jobId, duplicateOfIds);
  } catch (err) {
    if (!(err instanceof ImportError)) {
      reportError(`model import ${jobId} failed`, err);
    }
    await updateImportJob(jobId, {
      status: "failed",
      error:
        err instanceof ImportError
          ? err.message
          : "Import failed unexpectedly — check the server logs",
    }).catch(() => {});
  } finally {
    clearInterval(heartbeat);
  }
}

async function runJob(jobId: string, duplicateOfIds: string[]) {
  const job = await db.query.importJobs.findFirst({
    where: eq(importJobs.id, jobId),
  });
  if (!job || job.status !== "running") return;

  const url = new URL(job.sourceUrl);
  const importer = importerForUrl(url);
  if (!importer) throw new ImportError("Unsupported URL");

  const step = await importer.importUrl(url, {
    userId: job.userId,
    confirmManyFiles: true,
    body: {},
  });
  if ("prompt" in step) {
    throw new ImportError(
      "This link needs choices made in a dialog (like which Onshape tabs to export) — import it with the regular import instead",
    );
  }
  const project = step.project;

  await updateImportJob(jobId, { currentItem: project.title });
  if (await isImportJobCanceled(jobId)) return;

  const staged = await stageImportedAssets(project);
  const warnings = [...project.warnings, ...staged.warnings];
  // Staged objects no model references yet, so deleting them can't break a version snapshot. The early exits below would otherwise leave them stranded in storage.
  const discardStaged = () =>
    deleteS3Keys(staged.files.map((f) => f.key)).catch((err) =>
      reportError(`model import ${jobId}: cleaning up staged files failed`, err),
    );

  if (!staged.files.some((f) => f.kind === "model")) {
    await discardStaged();
    await updateImportJob(jobId, { warnings });
    throw new ImportError("No model file could be downloaded");
  }
  if (await isImportJobCanceled(jobId)) {
    await discardStaged();
    return;
  }

  // No form to pick a category in, so suggest one from the source's own categories plus tags and title, as the collection job does.
  const categoryId = await pickCategoryId({
    title: project.title,
    tags: project.tags,
    sourceCategories: project.categories,
  });
  const outcome = await createModelRecord(
    { id: job.userId },
    {
      title: project.title,
      description: project.description,
      categoryId,
      tags: project.tags,
      files: staged.files,
      bom: project.bom,
      sourceUrl: project.sourceUrl,
      sourceRevision: project.sourceRevision ?? null,
      // Flag-only, as everywhere else. The source-URL prompt was answered before the job started, and a file-hash match has nobody to ask, so both are recorded for the moderator worklist instead of blocking the save.
      confirmDuplicate: true,
      duplicateOfIds,
    },
  );
  if (!("modelId" in outcome)) {
    await discardStaged();
    throw new ImportError(
      "error" in outcome ? outcome.error : "The model couldn't be saved",
    );
  }

  // Done even if a cancel landed during the save: the model exists, and the indicator should say so.
  await updateImportJob(jobId, {
    status: "done",
    completed: 1,
    modelId: outcome.modelId,
    warnings,
  });
}
