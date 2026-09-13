// Slice-push resolve (issue #122): "which model is this file on my disk?"
//
// The endpoint that lets the OrcaSlicer plugin work with no per-model setup.
// The plugin sends what it knows about the open project — the SHA-256 of each
// file it was loaded from, their names, and the Bambu design id in the 3MF —
// and gets back ranked candidates. A file this instance served hashes exactly
// equal to the stored object, so the common case is one hash match and the
// plugin never has to ask the user anything.
//
// Token-authed, not session-authed: the slicer has no cookie. The token is
// user-scoped, and every signed-in user may already edit every model, so this
// deliberately searches the whole catalogue rather than the caller's own
// models — see docs/architecture/auth-and-access.md.

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { modelFiles, models } from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { authenticatePush, stampPushTokenUse } from "@/lib/push-tokens";
import {
  isContentHash,
  rankPushCandidates,
  type PushCandidate,
} from "@/lib/slice-push";
import { reportError } from "@/lib/telemetry";

export const runtime = "nodejs";

// One open project has a handful of parts, not hundreds. Caps the IN-list a
// single request can build without rejecting a legitimately multi-part plate.
const MAX_LOOKUPS = 32;

type ResolveBody = {
  hashes?: unknown;
  filenames?: unknown;
  designId?: unknown;
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

export async function POST(req: NextRequest) {
  const auth = await authenticatePush(req.headers.get("authorization"));
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: ResolveBody;
  try {
    body = (await req.json()) as ResolveBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const hashes = [...new Set(stringList(body.hashes).filter(isContentHash))].slice(
    0,
    MAX_LOOKUPS,
  );
  // Same reduction the ingest route's normalizePushFilename does — last path
  // segment, plain filename characters only — so a Windows path or a stray
  // quote can't reach the query. Not that helper itself: it also enforces a
  // pushable extension, and what was *opened* may be a .3mf, .stl or .step.
  const filenames = [
    ...new Set(
      stringList(body.filenames)
        .map((name) => name.split(/[/\\]/).pop() ?? "")
        .map((name) => name.replace(/[^a-zA-Z0-9._ ()+-]/g, "_").trim())
        .filter((name) => name.length > 0 && name.length <= 200),
    ),
  ].slice(0, MAX_LOOKUPS);
  const designId =
    typeof body.designId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.designId)
      ? body.designId
      : null;

  const matches: PushCandidate[] = [];

  // Trash is a soft delete — a trashed model is not a push target, so it is
  // not a resolve target either (every model listing filters deleted_at).
  const live = isNull(models.deletedAt);
  const select = {
    modelId: models.id,
    modelTitle: models.title,
    fileId: modelFiles.id,
    filename: modelFiles.filename,
  };

  if (hashes.length > 0) {
    const rows = await db
      .select(select)
      .from(modelFiles)
      .innerJoin(models, eq(models.id, modelFiles.modelId))
      .where(
        and(
          inArray(modelFiles.contentHash, hashes),
          eq(modelFiles.kind, "model"),
          live,
        ),
      )
      .orderBy(desc(models.updatedAt))
      .limit(MAX_LOOKUPS);
    matches.push(...rows.map((row) => ({ ...row, via: "hash" as const })));
  }

  if (filenames.length > 0) {
    const rows = await db
      .select(select)
      .from(modelFiles)
      .innerJoin(models, eq(models.id, modelFiles.modelId))
      .where(
        and(
          inArray(
            sql`lower(${modelFiles.filename})`,
            filenames.map((name) => name.toLowerCase()),
          ),
          eq(modelFiles.kind, "model"),
          live,
        ),
      )
      .orderBy(desc(models.updatedAt))
      .limit(MAX_LOOKUPS);
    matches.push(...rows.map((row) => ({ ...row, via: "filename" as const })));
  }

  // A 3MF exported from MakerWorld carries the design id it came from, which
  // is the tail of the source URL an imported model records. Weakest signal of
  // the three (it identifies the design, not the file), so it only ever adds
  // candidates the dialog offers — never one the plugin pushes to silently.
  if (designId) {
    const rows = await db
      .select({ modelId: models.id, modelTitle: models.title })
      .from(models)
      .where(and(live, sql`${models.sourceUrl} LIKE ${`%/${designId}%`}`))
      .orderBy(desc(models.updatedAt))
      .limit(MAX_LOOKUPS);
    matches.push(
      ...rows.map((row) => ({
        ...row,
        fileId: null,
        filename: null,
        via: "source" as const,
      })),
    );
  }

  const candidates = rankPushCandidates(matches).map((candidate) => ({
    ...candidate,
    url: appUrl(`/models/${candidate.modelId}`).toString(),
    pushUrl: appUrl(`/api/models/${candidate.modelId}/slice-push`).toString(),
  }));

  try {
    await stampPushTokenUse(auth.tokenId);
  } catch (err) {
    reportError(`slice-push could not stamp token ${auth.tokenId}`, err);
  }

  return NextResponse.json({ candidates });
}
