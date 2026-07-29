// Duplicate detection for imports and uploads (issue #118). Catalog-wide and
// flag-only: a match never blocks, it just asks "this already exists — skip or
// continue?" before the expensive part runs. Deliberately not scoped to the
// importing user (unlike the collection job's own sourceUrl dedup) — this is a
// shared library, so someone re-importing what a colleague already added
// should see the flag too.
//
// The pure key derivation lives in @/lib/duplicate-key so it can be unit
// tested; this module only wires it to the database.

import { and, count, desc, eq, inArray, isNull, like, ne } from "drizzle-orm";
import { db } from "@/db";
import { modelDuplicates, modelFiles, models } from "@/db/schema";
import { fileSrc } from "@/lib/file-token";
import {
  isContentHash,
  type DuplicateVia,
  sameSourceKey,
  sourceKeyFromUrl,
  sourceKeyUrlFragment,
  type SourceKey,
} from "@/lib/duplicate-key";

// An existing model the caller is about to duplicate, in the shape the
// confirmation dialogs render (link + thumbnail + who added it).
export type DuplicateMatch = {
  id: string;
  title: string;
  sourceUrl: string | null;
  ownerName: string;
  // Token-signed cover image URL, signed here because the dialog rendering it
  // is a client component. Null for a model with no images.
  coverSrc: string | null;
  createdAt: string;
};

// Never flag more than a handful: the dialog lists them, and a design already
// imported a dozen times needs one decision, not a wall of cards.
const MAX_MATCHES = 5;

// Rows to consider before the authoritative in-JS comparison. The LIKE
// prefilter is a substring scan (no index helps it), so cap it — a catalog
// where one fragment matches more than this has bigger problems than dedup.
const MAX_CANDIDATES = 50;

/**
 * Models whose `sourceUrl` names the same upstream design as `key`.
 * Trashed models are excluded — a model the owner threw away shouldn't block
 * a fresh reimport.
 */
export async function findDuplicatesBySourceUrl(
  key: SourceKey,
  opts: { excludeModelId?: string } = {},
): Promise<DuplicateMatch[]> {
  const fragment = sourceKeyUrlFragment(key);
  const candidates = await loadCandidates(
    and(
      like(models.sourceUrl, `%${fragment}%`),
      opts.excludeModelId ? ne(models.id, opts.excludeModelId) : undefined,
    ),
  );

  // The fragment over-matches ("/models/12" also hits model 123), so the
  // parsed key decides.
  return candidates
    .filter((m) => sameSourceKey(sourceKeyFromUrl(m.sourceUrl), key))
    .slice(0, MAX_MATCHES)
    .map(toMatch);
}

/**
 * Models holding a model file with one of these content hashes — the signal
 * for a raw upload of a file the catalog already has, where there is no
 * `sourceUrl` to compare (direct upload, archive import).
 *
 * Generated OpenSCAD variants are excluded: they are derived files the
 * customizer regenerates on demand, already deduped among themselves by
 * `generatedParamsHash`, and the archive importer skips them for a related
 * reason. Trashed models are excluded like everywhere else.
 */
export async function findDuplicatesByContentHash(
  hashes: (string | null | undefined)[],
  opts: { excludeModelId?: string } = {},
): Promise<DuplicateMatch[]> {
  const unique = [...new Set(hashes.filter(isContentHash))];
  if (unique.length === 0) return [];

  // Two steps rather than a join: the relational query below can't filter a
  // model by a property of its files, and the hash lookup is index-backed.
  const hits = await db
    .select({ modelId: modelFiles.modelId })
    .from(modelFiles)
    .where(
      and(
        inArray(modelFiles.contentHash, unique),
        eq(modelFiles.kind, "model"),
        isNull(modelFiles.generatedFromId),
      ),
    )
    .limit(MAX_CANDIDATES);

  const ids = [...new Set(hits.map((h) => h.modelId))].filter(
    (id) => id !== opts.excludeModelId,
  );
  if (ids.length === 0) return [];

  const candidates = await loadCandidates(inArray(models.id, ids));
  return candidates.slice(0, MAX_MATCHES).map(toMatch);
}

/** Convenience wrapper: the same lookup starting from a raw URL. */
export async function findDuplicatesForUrl(
  raw: string | URL | null | undefined,
  opts: { excludeModelId?: string } = {},
): Promise<DuplicateMatch[]> {
  const key = sourceKeyFromUrl(raw);
  if (!key) return [];
  return findDuplicatesBySourceUrl(key, opts);
}

// Oldest first: the model that was there before is the one the user should
// look at. Trashed models never match — a model the owner threw away shouldn't
// stand in the way of adding it back.
function loadCandidates(where: ReturnType<typeof and>, limit = MAX_CANDIDATES) {
  return db.query.models.findMany({
    where: and(isNull(models.deletedAt), where),
    columns: { id: true, title: true, sourceUrl: true, createdAt: true },
    with: {
      user: { columns: { name: true } },
      files: {
        where: (f, { eq: is }) => is(f.kind, "image"),
        orderBy: (f, { asc }) => asc(f.position),
        limit: 1,
        columns: { id: true },
      },
    },
    orderBy: (m, { asc }) => asc(m.createdAt),
    limit,
  });
}

type CandidateRow = {
  id: string;
  title: string;
  sourceUrl: string | null;
  createdAt: Date;
  user: { name: string } | null;
  files: { id: string }[];
};

function toMatch(row: CandidateRow): DuplicateMatch {
  return {
    id: row.id,
    title: row.title,
    sourceUrl: row.sourceUrl,
    ownerName: row.user?.name ?? "someone",
    coverSrc: row.files[0] ? fileSrc(row.files[0].id) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

// --- Dismissed matches (phase 3) ---

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Records that `modelId` was flagged as a duplicate of these models and the
 * user continued anyway, so a moderator can scrub the copy later
 * (Settings → Duplicates). Never throws on a repeat: the unique index plus
 * onConflictDoNothing make re-saving the same pair a no-op.
 *
 * Takes the transaction so the rows land with the model they describe — a
 * rolled-back create must not leave a match pointing at nothing.
 */
export async function recordDuplicateMatches(
  tx: Tx,
  modelId: string,
  matches: { duplicateOfId: string; via: DuplicateVia }[],
): Promise<void> {
  // A model is never a duplicate of itself (an edit re-adding its own file),
  // and one pair gets one row even when both signals fired — the worklist
  // shows pairs, not signals, so the first `via` given wins.
  const seen = new Set<string>([modelId]);
  const rows: {
    modelId: string;
    duplicateOfId: string;
    detectedVia: DuplicateVia;
  }[] = [];
  for (const match of matches) {
    if (seen.has(match.duplicateOfId)) continue;
    seen.add(match.duplicateOfId);
    rows.push({ modelId, duplicateOfId: match.duplicateOfId, detectedVia: match.via });
  }
  if (rows.length === 0) return;
  await tx.insert(modelDuplicates).values(rows).onConflictDoNothing();
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Filters caller-supplied model ids down to models that actually exist and
 * aren't trashed. The URL-import ids arrive through the client draft, and a
 * bogus id would otherwise fail the FK and take the whole save down with it
 * (a non-UUID string doesn't even reach the query — Postgres would error on
 * the cast rather than return no rows).
 */
export async function existingModelIds(ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)].filter((id) => UUID_RE.test(id));
  if (unique.length === 0) return [];
  const rows = await db
    .select({ id: models.id })
    .from(models)
    .where(and(inArray(models.id, unique), isNull(models.deletedAt)));
  return rows.map((r) => r.id);
}

export type OpenDuplicate = {
  id: string;
  detectedVia: DuplicateVia;
  flaggedAt: string;
  // The copy that was added past the flag, and the model it duplicates. The
  // original can be null: it may itself have been trashed since, and the flag
  // still deserves an explicit dismissal rather than vanishing.
  copy: DuplicateMatch;
  original: DuplicateMatch | null;
};

/**
 * The moderator worklist: dismissed duplicate flags whose copy is still in the
 * library, newest first, with both models hydrated for display. A copy that has
 * since been trashed needs no review — nothing is duplicated while it sits in
 * the trash — so the join drops it, and restoring it brings the flag back.
 */
export async function listOpenDuplicates(limit = 100): Promise<OpenDuplicate[]> {
  const rows = await db
    .select({
      id: modelDuplicates.id,
      modelId: modelDuplicates.modelId,
      duplicateOfId: modelDuplicates.duplicateOfId,
      detectedVia: modelDuplicates.detectedVia,
      createdAt: modelDuplicates.createdAt,
    })
    .from(modelDuplicates)
    .innerJoin(models, eq(models.id, modelDuplicates.modelId))
    .where(isNull(models.deletedAt))
    .orderBy(desc(modelDuplicates.createdAt))
    .limit(limit);
  if (rows.length === 0) return [];

  // One query for both sides, stitched in JS: two joins onto `models` would
  // need aliasing, and this also picks up each model's cover image.
  const ids = [...new Set(rows.flatMap((r) => [r.modelId, r.duplicateOfId]))];
  const byId = new Map(
    (await loadCandidates(inArray(models.id, ids), ids.length)).map((m) => [
      m.id,
      toMatch(m),
    ]),
  );

  return rows.flatMap((row) => {
    const copy = byId.get(row.modelId);
    // Guaranteed by the join, but the map lookup can't know that.
    if (!copy) return [];
    return [
      {
        id: row.id,
        detectedVia: row.detectedVia,
        flaggedAt: row.createdAt.toISOString(),
        copy,
        original: byId.get(row.duplicateOfId) ?? null,
      },
    ];
  });
}

/** Count for the Settings nav badge — matches what listOpenDuplicates shows. */
export async function countOpenDuplicates(): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(modelDuplicates)
    .innerJoin(models, eq(models.id, modelDuplicates.modelId))
    .where(isNull(models.deletedAt));
  return row?.value ?? 0;
}
