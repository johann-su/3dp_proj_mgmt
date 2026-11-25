// import_jobs bookkeeping shared by the two background runners: collection-job.ts (a whole MakerWorld collection) and model-job.ts (one model link). Both are scheduled via next/server `after()`, heartbeat through updatedAt, and surface in the header indicator (src/components/import-progress.tsx).

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { importJobs } from "@/db/schema";

export type ImportJobRow = typeof importJobs.$inferSelect;

// One import at a time per user, whatever its kind: a second job would fight the first for the platform's rate limits, and the header indicator shows a single job.
export const IMPORT_ALREADY_RUNNING =
  "Another import is already running — wait for it to finish";

export async function hasRunningImport(userId: string): Promise<boolean> {
  const running = await db.query.importJobs.findFirst({
    where: and(eq(importJobs.userId, userId), eq(importJobs.status, "running")),
    columns: { id: true },
  });
  return !!running;
}

// Every write bumps updatedAt, which doubles as the heartbeat GET /api/import-jobs uses to fail jobs a server restart orphaned.
export async function updateImportJob(jobId: string, values: Partial<ImportJobRow>) {
  await db
    .update(importJobs)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(importJobs.id, jobId));
}

// The user canceled (POST /api/import-jobs/{id}/cancel) or the row is gone — either way the runner should stop.
export async function isImportJobCanceled(jobId: string): Promise<boolean> {
  const row = await db.query.importJobs.findFirst({
    where: eq(importJobs.id, jobId),
    columns: { status: true },
  });
  return !row || row.status === "canceled";
}
