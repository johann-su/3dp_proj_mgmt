// MakerWorld collection reader. Collections are "favorites lists" in the
// Bambu design API: the anonymous api.bambulab.com endpoints
//
//   GET /v1/design-service/favorites/{collectionId}            (metadata)
//   GET /v1/design-service/favorites/{collectionId}/designs    (contents,
//       paginated with limit/offset, hidden designs excluded)
//
// return them without auth — discovered from MakerWorld's own frontend, which
// calls getFavorites() for its /collections/{id} pages. Used by the
// collection import job (see src/lib/import/collection-job.ts).

import { apiBase, type BambuRegion } from "@/lib/bambu/cloud";
import { ImportError, IMPORT_USER_AGENT } from "./types";

// Upper bound on designs imported from one collection — keeps a runaway job
// (someone pastes a 5000-model mega-list) from filling the library and the
// job from running for days.
export const MAX_COLLECTION_DESIGNS = 200;

const PAGE_SIZE = 50;

export function parseMakerworldCollectionUrl(url: URL): string | null {
  if (!/(^|\.)makerworld\.com$/.test(url.hostname)) return null;
  const match = url.pathname.match(/\/collections\/(\d+)/);
  return match ? match[1] : null;
}

export type MakerworldCollection = {
  id: number;
  title: string;
  description: string;
  designCnt: number;
};

export type MakerworldCollectionDesign = {
  id: number;
  title: string;
};

function headers() {
  return { "User-Agent": IMPORT_USER_AGENT, Accept: "application/json" };
}

export async function fetchMakerworldCollection(
  collectionId: string,
  region: BambuRegion = "global",
): Promise<MakerworldCollection> {
  const res = await fetch(
    `${apiBase(region)}/v1/design-service/favorites/${collectionId}`,
    { headers: headers(), redirect: "follow" },
  );
  if (!res.ok) {
    throw new ImportError(
      res.status === 404
        ? "MakerWorld collection not found — it may be private or deleted"
        : `MakerWorld API responded with ${res.status}`,
    );
  }
  const data = (await res.json().catch(() => null)) as {
    id?: number;
    title?: string;
    description?: string;
    designCnt?: number;
  } | null;
  // Like the design endpoint, missing ids come back as an empty envelope.
  if (!data?.id || !data.title) {
    throw new ImportError("MakerWorld collection not found");
  }
  return {
    id: data.id,
    title: data.title.trim(),
    description: (data.description ?? "").trim(),
    designCnt: data.designCnt ?? 0,
  };
}

// Lists the designs of a collection (id + title only — the import job fetches
// full metadata per design). Pages until the API stops returning hits; capped
// at MAX_COLLECTION_DESIGNS.
export async function listMakerworldCollectionDesigns(
  collectionId: string,
  region: BambuRegion = "global",
): Promise<MakerworldCollectionDesign[]> {
  const designs: MakerworldCollectionDesign[] = [];
  const seen = new Set<number>();

  for (let offset = 0; designs.length < MAX_COLLECTION_DESIGNS; offset += PAGE_SIZE) {
    const res = await fetch(
      `${apiBase(region)}/v1/design-service/favorites/${collectionId}/designs?limit=${PAGE_SIZE}&offset=${offset}`,
      { headers: headers(), redirect: "follow" },
    );
    if (!res.ok) {
      throw new ImportError(`MakerWorld API responded with ${res.status}`);
    }
    const data = (await res.json().catch(() => null)) as {
      hits?: { id?: number; title?: string }[];
      total?: number;
    } | null;
    const hits = data?.hits ?? [];
    if (hits.length === 0) break;

    for (const hit of hits) {
      if (typeof hit.id !== "number" || seen.has(hit.id)) continue;
      seen.add(hit.id);
      designs.push({ id: hit.id, title: hit.title?.trim() || `Model ${hit.id}` });
    }

    if (typeof data?.total === "number" && offset + PAGE_SIZE >= data.total) break;
  }

  return designs.slice(0, MAX_COLLECTION_DESIGNS);
}
