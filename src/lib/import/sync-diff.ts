// Pure diff engine for the MakerWorld/Printables source sync: given the
// model's local files and the platform's current file list, decide what to
// import, replace, remove and re-stamp. DB-free and network-free on purpose —
// the sync route (src/app/api/models/[id]/source-sync) does the fetching and
// writing.
//
// The sync contract in one line: **imported files mirror upstream, everything
// else is local**. Manual uploads (imported = false) and generated OpenSCAD
// variants are invisible to the planner, images are out of scope entirely,
// and metadata (title/description/tags/BOM) is never touched — so there is no
// merge to resolve: upstream owns the imported files, the user owns the rest.

export type UpstreamFile = {
  // Stable per-file identity, prefixed by group so ids can't collide:
  // "profile:<id>" (MakerWorld print profile), "scad:<basename>" (raw-file
  // OpenSCAD source), "doc:<filename>" (attached PDF), "file:<id>"
  // (Printables file). Import stamps the same ids onto model_files.
  sourceFileId: string;
  filename: string;
  kind: "model" | "pdf";
  // Opaque last-modified token (the platform's ISO date string), null when
  // the platform exposes none (MakerWorld doc PDFs). Compared for equality,
  // not order — upstream only ever moves forward.
  modifiedAt: string | null;
};

// The subset of a model_files row the planner needs.
export type LocalSyncFile = {
  id: string;
  filename: string;
  kind: string;
  imported: boolean;
  generatedFromId: string | null;
  sourceFileId: string | null;
  sourceModifiedAt: string | null;
  createdAt: Date;
};

export type SyncPlan<U extends UpstreamFile> = {
  // Upstream files with no local counterpart — download and insert.
  toImport: U[];
  // Matched files whose upstream token moved — download and replace the row
  // (the new row inherits the old position).
  toReplace: { local: LocalSyncFile; upstream: U }[];
  // Local imported files no longer present upstream — remove the row (the
  // bytes stay in S3 via the pre-sync version snapshot).
  toRemove: LocalSyncFile[];
  // Matched-and-unchanged files whose stored id/token is stale (adopted
  // legacy imports, or a token refresh) — update the columns in place.
  toStamp: { localId: string; sourceFileId: string; sourceModifiedAt: string | null }[];
};

export function planIsEmpty(plan: SyncPlan<UpstreamFile>): boolean {
  return (
    plan.toImport.length === 0 &&
    plan.toReplace.length === 0 &&
    plan.toRemove.length === 0
  );
}

// Has the matched file changed upstream? With a stored token this is a plain
// inequality. Without one (imports predating the feature, or a file adopted
// by filename) fall back to comparing the upstream date against when the
// local row was created: modified after we imported it means our copy is
// stale, modified before means our copy already is that version. Unparseable
// or missing upstream dates count as unchanged — never loop re-downloading a
// file we can't fingerprint.
function hasChanged(local: LocalSyncFile, upstream: UpstreamFile): boolean {
  if (upstream.modifiedAt === null) return false;
  if (local.sourceModifiedAt !== null) {
    return upstream.modifiedAt !== local.sourceModifiedAt;
  }
  const upstreamDate = Date.parse(upstream.modifiedAt);
  if (Number.isNaN(upstreamDate)) return false;
  return upstreamDate > local.createdAt.getTime();
}

export function computeSyncPlan<U extends UpstreamFile>(
  localFiles: LocalSyncFile[],
  upstreamFiles: U[],
): SyncPlan<U> {
  // Only imported, non-variant model/pdf files are in the sync domain.
  const local = localFiles.filter(
    (f) =>
      f.imported &&
      f.generatedFromId === null &&
      (f.kind === "model" || f.kind === "pdf"),
  );

  const byId = new Map(
    local.filter((f) => f.sourceFileId !== null).map((f) => [f.sourceFileId, f]),
  );
  // Pre-feature imports have no stored id — adopt them by filename, first
  // match wins.
  const adoptable = new Map(
    local
      .filter((f) => f.sourceFileId === null)
      .reverse()
      .map((f) => [f.filename, f]),
  );

  const plan: SyncPlan<U> = { toImport: [], toReplace: [], toRemove: [], toStamp: [] };
  const matchedLocalIds = new Set<string>();

  for (const upstream of upstreamFiles) {
    let match = byId.get(upstream.sourceFileId);
    if (!match) {
      match = adoptable.get(upstream.filename);
      if (match) adoptable.delete(upstream.filename);
    }
    if (!match) {
      plan.toImport.push(upstream);
      continue;
    }
    matchedLocalIds.add(match.id);
    if (hasChanged(match, upstream)) {
      plan.toReplace.push({ local: match, upstream });
    } else if (
      match.sourceFileId !== upstream.sourceFileId ||
      match.sourceModifiedAt !== upstream.modifiedAt
    ) {
      plan.toStamp.push({
        localId: match.id,
        sourceFileId: upstream.sourceFileId,
        sourceModifiedAt: upstream.modifiedAt,
      });
    }
  }

  plan.toRemove = local.filter((f) => !matchedLocalIds.has(f.id));
  return plan;
}
