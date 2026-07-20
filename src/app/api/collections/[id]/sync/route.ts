import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { collections } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { ImportError } from "@/lib/import/types";
import { startCollectionImport } from "@/lib/import/collection-job";
import { reportError } from "@/lib/telemetry";

export const runtime = "nodejs";

// Re-runs the collection import against the stored MakerWorld source URL
// (any signed-in user — syncing counts as editing; see the session check
// below). Designs added remotely since the last run import as new
// models; everything already in the library is just (re-)linked into the
// collection. Nothing is deleted — models removed from the remote collection
// stay local.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const collection = await db.query.collections.findFirst({
    where: eq(collections.id, id),
    columns: { id: true, userId: true, sourceUrl: true },
  });
  if (!collection) {
    return NextResponse.json({ error: "Collection not found" }, { status: 404 });
  }
  // Syncing re-imports the MakerWorld list into this collection, so it counts
  // as editing — open to any signed-in user (uses their own Bambu connection;
  // newly-imported models are owned by the syncer and linked here). Only
  // deletion is owner-gated.
  if (!collection.sourceUrl) {
    return NextResponse.json(
      { error: "This collection was not imported from MakerWorld" },
      { status: 400 },
    );
  }

  try {
    const result = await startCollectionImport(
      session.user.id,
      new URL(collection.sourceUrl),
      collection.id,
    );
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ jobId: result.jobId, total: result.total });
  } catch (err) {
    if (err instanceof ImportError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    reportError("Collection sync failed to start", err);
    return NextResponse.json({ error: "Sync failed — try again" }, { status: 500 });
  }
}
