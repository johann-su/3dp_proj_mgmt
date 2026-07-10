import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { collections, importJobs } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { getBambuCredential } from "@/lib/bambu/credentials";
import { ImportError } from "@/lib/import/types";
import {
  fetchMakerworldCollection,
  parseMakerworldCollectionUrl,
} from "@/lib/import/makerworld-collection";
import { runCollectionImportJob } from "@/lib/import/collection-job";

export const runtime = "nodejs";

// Starts a background import of a whole MakerWorld collection: validates the
// URL and the user's Bambu connection, creates a local collection plus an
// import_jobs row, and kicks the runner off via after(). The response returns
// immediately — progress is polled from GET /api/import-jobs.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { url?: string } | null;
  let url: URL;
  try {
    url = new URL(body?.url ?? "");
  } catch {
    return NextResponse.json({ error: "Enter a valid URL" }, { status: 400 });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return NextResponse.json({ error: "Enter a valid http(s) URL" }, { status: 400 });
  }
  url.search = "";

  const collectionId = parseMakerworldCollectionUrl(url);
  if (!collectionId) {
    return NextResponse.json(
      {
        error:
          "Not a MakerWorld collection URL (expected makerworld.com/…/collections/<id>)",
      },
      { status: 400 },
    );
  }

  // Bulk-importing metadata-only models (no .3mf) would leave dozens of
  // shells to fix by hand, so a connected Bambu account is required up front.
  const cred = await getBambuCredential(session.user.id);
  if (!cred) {
    return NextResponse.json(
      {
        error:
          "Collection import downloads .3mf files, which needs a connected Bambu account — connect it in Settings → Bambu Cloud first",
      },
      { status: 400 },
    );
  }

  // One import at a time per user; a second job would fight the first for
  // Bambu API rate limits and make the progress indicator ambiguous.
  const running = await db.query.importJobs.findFirst({
    where: and(
      eq(importJobs.userId, session.user.id),
      eq(importJobs.status, "running"),
    ),
    columns: { id: true },
  });
  if (running) {
    return NextResponse.json(
      { error: "Another import is already running — wait for it to finish" },
      { status: 409 },
    );
  }

  try {
    const remote = await fetchMakerworldCollection(collectionId, cred.region);
    if (remote.designCnt === 0) {
      return NextResponse.json(
        { error: "This collection is empty" },
        { status: 400 },
      );
    }

    const { job, localCollectionId } = await db.transaction(async (tx) => {
      const [collection] = await tx
        .insert(collections)
        .values({
          title: remote.title,
          description: remote.description,
          userId: session.user.id,
        })
        .returning({ id: collections.id });
      const [job] = await tx
        .insert(importJobs)
        .values({
          userId: session.user.id,
          sourceUrl: url.toString(),
          collectionId: collection.id,
          // Corrected to the listed (non-hidden) count once the runner starts.
          total: remote.designCnt,
        })
        .returning();
      return { job, localCollectionId: collection.id };
    });

    after(() => runCollectionImportJob(job.id));

    return NextResponse.json({
      jobId: job.id,
      collectionId: localCollectionId,
      title: remote.title,
      total: remote.designCnt,
    });
  } catch (err) {
    if (err instanceof ImportError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error("Collection import failed to start", err);
    return NextResponse.json(
      { error: "Import failed — check the URL and try again" },
      { status: 500 },
    );
  }
}
