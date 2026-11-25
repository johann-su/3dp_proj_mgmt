import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { startModelImport } from "@/lib/import/model-job";
import { reportError } from "@/lib/telemetry";
import type { DuplicateConfirmationResponse } from "../route";

export const runtime = "nodejs";

// Starts a background import of one model link (the import page's "Import in background" button). Validation and the duplicate check answer right away; the import itself runs in an import_jobs job after the response, saves the model without the create form, and reports progress through GET /api/import-jobs.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    url?: string;
    // Set once the user has agreed to import a design the catalog already holds, as on POST /api/import.
    confirmDuplicate?: boolean;
  } | null;
  let url: URL;
  try {
    url = new URL(body?.url ?? "");
  } catch {
    return NextResponse.json({ error: "Enter a valid URL" }, { status: 400 });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return NextResponse.json({ error: "Enter a valid http(s) URL" }, { status: 400 });
  }
  // Same canonicalization as POST /api/import: the importers only use the path.
  url.search = "";

  try {
    const result = await startModelImport(session.user.id, url, {
      confirmDuplicate: body?.confirmDuplicate === true,
    });
    if ("duplicates" in result) {
      return NextResponse.json({
        needsDuplicateConfirmation: true,
        duplicates: result.duplicates,
      } satisfies DuplicateConfirmationResponse);
    }
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ jobId: result.jobId });
  } catch (err) {
    reportError("Background import failed to start", err);
    return NextResponse.json(
      { error: "Import failed to start — check the URL and try again" },
      { status: 500 },
    );
  }
}
