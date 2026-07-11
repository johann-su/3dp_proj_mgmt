// Per-plate grouping for a Bambu/Orca multi-plate .3mf, so the browser preview
// can show one build plate at a time (like MakerWorld) instead of scattering
// every plate's objects across one huge virtual bed.
//
// The mapping is split across two archive entries:
//   - 3D/3dmodel.model              the <build> lists <item objectid="…">, one
//                                   per placed object, in the same order three's
//                                   3MFLoader adds them as the scene's children.
//   - Metadata/model_settings.config  one <plate> block per plate, each listing
//                                   its objects as <model_instance> → object_id.
// Correlating build-item order (→ child index) with the plate an object_id
// belongs to yields a plate index per scene child. This is pure so it can be
// unit-tested; the viewer feeds it the raw .3mf bytes.

import { unzipSync, strFromU8 } from "fflate";

export type PlateLayout = {
  // Display name per plate, in plate order.
  plateNames: string[];
  // Plate index (into plateNames) for each build item, in build order — which
  // is exactly the order 3MFLoader adds objects as top-level scene children.
  // -1 marks an object no plate claims (kept, shown on the first plate).
  plateOfBuildItem: number[];
};

const MODEL_PART_RE = /^3d\/3dmodel\.model$/;
const MODEL_SETTINGS_RE = /^metadata\/model_settings\.config$/;

// Ordered objectids of the placed objects, from the model's <build> section.
// `<item>` only appears inside <build> in the core 3MF spec, so a document-wide
// scan preserves build order without needing to isolate the block.
function buildItemObjectIds(modelXml: string): string[] {
  return [...modelXml.matchAll(/<item\b[^>]*\bobjectid="([^"]+)"/g)].map(
    (m) => m[1],
  );
}

type PlateDef = { name: string; objectIds: string[] };

function parsePlates(settingsXml: string): PlateDef[] {
  return settingsXml
    .split("<plate>")
    .slice(1)
    .map((chunk) => {
      const block = chunk.split("</plate>")[0];
      const name = block.match(
        /key="plater_name"\s+value="([^"]*)"/,
      )?.[1];
      const objectIds = [
        ...block.matchAll(/key="object_id"\s+value="(\d+)"/g),
      ].map((m) => m[1]);
      return { name: name?.trim() || "", objectIds };
    });
}

function findEntry(
  files: Record<string, Uint8Array>,
  re: RegExp,
): Uint8Array | null {
  for (const [name, bytes] of Object.entries(files)) {
    if (re.test(name.toLowerCase())) return bytes;
  }
  return null;
}

// Returns null when the archive isn't a multi-plate Bambu/Orca project (no
// model_settings, unparseable, or a single plate) — the caller then shows the
// whole model on one bed, which is already correct for those files.
export function parsePlateLayout(bytes: Uint8Array): PlateLayout | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      // Only decompress the two tiny config entries, never the mesh data.
      filter: (f) =>
        MODEL_PART_RE.test(f.name.toLowerCase()) ||
        MODEL_SETTINGS_RE.test(f.name.toLowerCase()),
    });
  } catch {
    return null;
  }

  const settingsBytes = findEntry(files, MODEL_SETTINGS_RE);
  const modelBytes = findEntry(files, MODEL_PART_RE);
  if (!settingsBytes || !modelBytes) return null;

  const plates = parsePlates(strFromU8(settingsBytes));
  if (plates.length <= 1) return null; // single plate needs no selector

  const objectIds = buildItemObjectIds(strFromU8(modelBytes));
  if (objectIds.length === 0) return null;

  // First plate that claims an object wins (an object placed once but listed
  // under several plates is rare; a stable choice is enough for a preview).
  const plateOf = new Map<string, number>();
  plates.forEach((plate, index) => {
    for (const id of plate.objectIds) {
      if (!plateOf.has(id)) plateOf.set(id, index);
    }
  });

  const plateOfBuildItem = objectIds.map((id) => plateOf.get(id) ?? -1);
  // If nothing correlated, the id spaces don't line up — fall back to the
  // whole-model view rather than showing empty plates.
  if (plateOfBuildItem.every((p) => p === -1)) return null;

  return {
    plateNames: plates.map((p, i) => p.name || `Plate ${i + 1}`),
    plateOfBuildItem,
  };
}
