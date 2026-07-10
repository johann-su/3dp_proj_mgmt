import { NextResponse } from "next/server";
import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { importJobs } from "@/db/schema";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

// A "running" job only makes progress while its runner is alive in the server
// process; after a restart nothing will ever touch it again. The runner
// heartbeats updatedAt on every design, so anything stale by far more than
// one design's worth of work is dead.
const STALL_MS = 10 * 60_000;

// Recent import jobs of the signed-in user, newest first — polled by the
// header progress indicator.
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Self-healing like the slicer: mark orphaned jobs failed on poll.
  await db
    .update(importJobs)
    .set({
      status: "failed",
      error: "Import stopped unexpectedly — the server may have restarted",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(importJobs.userId, session.user.id),
        eq(importJobs.status, "running"),
        lt(importJobs.updatedAt, new Date(Date.now() - STALL_MS)),
      ),
    );

  const jobs = await db.query.importJobs.findMany({
    where: eq(importJobs.userId, session.user.id),
    orderBy: desc(importJobs.createdAt),
    limit: 3,
    columns: {
      id: true,
      status: true,
      sourceUrl: true,
      collectionId: true,
      total: true,
      completed: true,
      failed: true,
      skipped: true,
      currentItem: true,
      error: true,
      warnings: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ jobs });
}
