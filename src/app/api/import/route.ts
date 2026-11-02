import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import type { ModelVideo } from "@/lib/video";
import { ImportError } from "@/lib/import/types";
import { stageImportedAssets } from "@/lib/import/stage";
import type { UploadedFile } from "@/app/models/actions";
import type { BomItemInput } from "@/lib/bom";
import { findDuplicatesForUrl, type DuplicateMatch } from "@/lib/duplicates";
import { importerForUrl, importRejection } from "@/lib/sources/importers";
import { supportedSourcesSentence } from "@/lib/sources/registry";
import { reportError } from "@/lib/telemetry";

// The Onshape tab/branch prompt is the Onshape importer's own; re-exported for
// the import form, which renders it.
export type { OnshapeSelectionResponse } from "@/lib/sources/importers";

export const runtime = "nodejs";
// Downloading large model files from the source platform can take a while.
export const maxDuration = 300;

// First-POST answer when the catalog already holds the design this URL names
// (issue #118): the client shows the existing model(s) and re-POSTs with
// `confirmDuplicate` if the user still wants it. Flag-only — nothing is
// blocked, and the dismissed match is recorded on save.
export type DuplicateConfirmationResponse = {
  needsDuplicateConfirmation: true;
  duplicates: DuplicateMatch[];
};

export type ImportDraft = {
  source: string;
  sourceUrl: string;
  title: string;
  description: string;
  tags: string[];
  // Source platform category names (most specific first) — the create form
  // uses them to suggest one of our categories.
  categories: string[];
  // Files already staged in S3. The platform importers only ever produce
  // `imported: true` files (StagedImportFile); the archive importer
  // (/api/import/archive) restores whatever provenance the archive recorded,
  // so the shared draft type is the wider UploadedFile.
  files: UploadedFile[];
  bom: BomItemInput[];
  // Gallery videos with their carousel slots. Only the archive importer
  // produces any — the platform importers don't scrape videos.
  videos?: ModelVideo[];
  warnings: string[];
  // Upstream revision token (models.source_revision) — see ImportedProject.
  sourceRevision?: string | null;
  // Models this import was flagged against and the user chose to import
  // anyway; createModel records them for later admin review.
  duplicateOfIds?: string[];
};

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Besides the fields read here, the body carries source-specific answers to
  // an earlier prompt (Onshape's `onshapeElements`/`onshapeWvm`/
  // `onshapeWvmId`), which go to the importer untouched.
  const body = (await req.json().catch(() => null)) as {
    url?: string;
    // Set once the user has agreed to import a model with a lot of files
    // (the Continue/Cancel prompt in import-form.tsx).
    confirm?: boolean;
    // Set once the user has agreed to import a design the catalog already
    // holds. Deliberately a separate flag from `confirm`: the duplicate
    // prompt comes first, and reusing `confirm` would silently answer the
    // many-files prompt that may follow it.
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
  // Drop tracking params (?from=recommend etc.) so the stored source URL and
  // the draft shown in the form are canonical. The importers only use the path.
  url.search = "";

  const importer = importerForUrl(url);
  if (!importer) {
    return NextResponse.json(
      {
        error:
          importRejection(url) ??
          `Unsupported URL — paste a ${supportedSourcesSentence()} link`,
      },
      { status: 400 },
    );
  }

  try {
    // Is this design already in the catalog? Checked before any platform call
    // — the same "don't do the expensive part yet" shape as the many-files and
    // Onshape-tab round-trips. Matching is by platform + id, not by the URL
    // string (a different print profile or Onshape branch is the same design).
    const duplicates = await findDuplicatesForUrl(url);
    if (duplicates.length > 0 && body?.confirmDuplicate !== true) {
      return NextResponse.json({
        needsDuplicateConfirmation: true,
        duplicates,
      } satisfies DuplicateConfirmationResponse);
    }

    const step = await importer.importUrl(url, {
      userId: session.user.id,
      confirmManyFiles: body?.confirm === true,
      body: body ?? {},
    });
    // The importer needs an answer first (Onshape's tab picker).
    if ("prompt" in step) return NextResponse.json(step.prompt);
    const project = step.project;

    // The importer stopped before resolving downloads because the model has a
    // lot of files — ask the client to confirm, then it re-POSTs with confirm.
    if (project.needsConfirmation) {
      return NextResponse.json({
        needsConfirmation: true,
        fileCount: project.fileCount ?? 0,
        title: project.title,
      });
    }

    const staged = await stageImportedAssets(project);
    const draft: ImportDraft = {
      source: project.source,
      sourceUrl: project.sourceUrl,
      title: project.title,
      description: project.description,
      tags: project.tags,
      categories: project.categories,
      files: staged.files,
      bom: project.bom,
      warnings: [...project.warnings, ...staged.warnings],
      sourceRevision: project.sourceRevision ?? null,
      // Non-empty only when the user imported past a flag (otherwise we
      // returned above). The ids come from our own lookup, never the body.
      duplicateOfIds: duplicates.map((d) => d.id),
    };

    return NextResponse.json(draft);
  } catch (err) {
    if (err instanceof ImportError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    reportError("Import failed", err);
    return NextResponse.json(
      { error: "Import failed — check the URL and try again" },
      { status: 500 },
    );
  }
}
