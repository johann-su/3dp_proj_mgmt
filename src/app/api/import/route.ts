import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ImportError, type ImportedProject } from "@/lib/import/types";
import { stageImportedAssets } from "@/lib/import/stage";
import type { UploadedFile } from "@/app/models/actions";
import type { BomItemInput } from "@/lib/bom";
import { importFromMakerworld, parseMakerworldUrl } from "@/lib/import/makerworld";
import { parseMakerworldCollectionUrl } from "@/lib/import/makerworld-collection";
import { importFromPrintables, parsePrintablesUrl } from "@/lib/import/printables";
import {
  importFromOnshape,
  listOnshapeImportTabs,
  type OnshapeBranchPick,
  type OnshapeImportTab,
} from "@/lib/import/onshape";
import {
  isOnshapeId,
  MAX_EXPORT_ELEMENTS,
  parseOnshapeUrl,
  type OnshapeBranchChoice,
} from "@/lib/onshape/api";
import { getBambuCredential } from "@/lib/bambu/credentials";
import { getOnshapeAccessToken } from "@/lib/onshape/credentials";
import { reportError } from "@/lib/telemetry";

export const runtime = "nodejs";
// Downloading large model files from the source platform can take a while.
export const maxDuration = 300;

// First-POST answer for a multi-tab or multi-branch Onshape document: the
// client shows the tab-selection dialog and re-POSTs with `onshapeElements`
// (plus `onshapeWvm`/`onshapeWvmId` when a branch/version was picked).
export type OnshapeSelectionResponse = {
  needsOnshapeSelection: true;
  title: string;
  tabs: OnshapeImportTab[];
  // Server-side export cap (MAX_EXPORT_ELEMENTS) — the dialog stops the user
  // from selecting more instead of silently truncating.
  maxTabs: number;
  // Branch/version dropdown entries and the one the tab list was read from;
  // picking another re-requests this listing (each branch has its own tabs).
  branches: OnshapeBranchChoice[];
  selected: OnshapeBranchPick;
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
  warnings: string[];
  onshapeMicroversion?: string | null;
};

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    url?: string;
    // Set once the user has agreed to import a model with a lot of files
    // (the Continue/Cancel prompt in import-form.tsx).
    confirm?: boolean;
    // Onshape only: the tabs picked in the selection dialog. Absent on the
    // first POST — the route answers with the document's tab list instead of
    // importing, and the client re-POSTs with the chosen element ids.
    onshapeElements?: string[];
    // Onshape only: the branch/version picked in the dialog's dropdown —
    // overrides the URL's /w|v/ pin for both the tab listing and the import.
    onshapeWvm?: string;
    onshapeWvmId?: string;
  } | null;
  const confirmManyFiles = body?.confirm === true;
  const onshapeElements = Array.isArray(body?.onshapeElements)
    ? body.onshapeElements.filter((v): v is string => typeof v === "string")
    : null;
  const onshapeBranch: OnshapeBranchPick | null =
    (body?.onshapeWvm === "w" || body?.onshapeWvm === "v") &&
    isOnshapeId(body.onshapeWvmId)
      ? { wvm: body.onshapeWvm, wvmId: body.onshapeWvmId }
      : null;
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

  try {
    let project: ImportedProject;
    if (parseMakerworldUrl(url)) {
      const cred = await getBambuCredential(session.user.id);
      project = await importFromMakerworld(
        url,
        cred
          ? { token: cred.token, region: cred.region, confirmManyFiles }
          : { confirmManyFiles },
      );
    } else if (parseMakerworldCollectionUrl(url)) {
      // Whole collections import in the background — see /api/import/collection.
      return NextResponse.json(
        {
          error:
            "That link is a MakerWorld collection — use the “Import collection” option instead",
        },
        { status: 400 },
      );
    } else {
      const printablesId = parsePrintablesUrl(url);
      const onshapePin = printablesId ? null : parseOnshapeUrl(url);
      if (printablesId) {
        project = await importFromPrintables(url, printablesId, { confirmManyFiles });
      } else if (onshapePin) {
        const accessToken = await getOnshapeAccessToken(session.user.id);
        const auth = accessToken ? { accessToken } : null;
        if (!onshapeElements) {
          // First POST (or a branch switch from the dialog): answer with the
          // tab list so the user picks what to import. A document with one
          // tab and no other branches/versions has nothing to choose —
          // import it, passing the tab explicitly so an ineligible pinned
          // tab (URL copied on e.g. a Variable Studio) can't derail the
          // export.
          const { title, tabs, branches, selected } = await listOnshapeImportTabs(
            onshapePin,
            auth,
            onshapeBranch,
          );
          if (tabs.length > 1 || branches.length > 1) {
            return NextResponse.json({
              needsOnshapeSelection: true,
              title,
              tabs,
              maxTabs: MAX_EXPORT_ELEMENTS,
              branches,
              selected,
            } satisfies OnshapeSelectionResponse);
          }
          project = await importFromOnshape(onshapePin, auth, {
            selectedElementIds: tabs.map((t) => t.id),
            branch: onshapeBranch,
          });
        } else {
          project = await importFromOnshape(onshapePin, auth, {
            selectedElementIds: onshapeElements,
            branch: onshapeBranch,
          });
        }
      } else {
        return NextResponse.json(
          {
            error:
              "Unsupported URL — paste a MakerWorld (makerworld.com/…/models/…), Printables (printables.com/model/…) or Onshape (cad.onshape.com/documents/…) link",
          },
          { status: 400 },
        );
      }
    }

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
      onshapeMicroversion: project.onshapeMicroversion ?? null,
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
