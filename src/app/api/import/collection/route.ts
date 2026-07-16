import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ImportError } from "@/lib/import/types";
import { startCollectionImport } from "@/lib/import/collection-job";
import { reportError } from "@/lib/telemetry";

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

  try {
    const result = await startCollectionImport(session.user.id, url);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    const { jobId, collectionId, title, total } = result;
    return NextResponse.json({ jobId, collectionId, title, total });
  } catch (err) {
    if (err instanceof ImportError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    reportError("Collection import failed to start", err);
    return NextResponse.json(
      { error: "Import failed — check the URL and try again" },
      { status: 500 },
    );
  }
}
