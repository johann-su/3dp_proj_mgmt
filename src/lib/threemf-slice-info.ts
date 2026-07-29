// Extraction of slicer metadata from a .3mf (ZIP) archive via ranged reads.
// A .3mf can be up to 1 GB, so instead of reading the whole archive the ZIP
// central directory is located from the tail and only the tiny slicer config
// entries are fetched:
//
// - Metadata/model_settings.config    one <plate> block per plate (present
//                                     even unsliced) + per-object extruders
// - Metadata/slice_info.config        <metadata key="prediction"/"weight">
//                                     per plate, only once the file was sliced
// - Metadata/project_settings.config  Bambu/Orca print+printer+filament
//                                     settings (JSON)
// - Metadata/Slic3r_PE.config         PrusaSlicer project settings (ini)
// - Metadata/Slic3r_PE_model.config   PrusaSlicer's per-object extruders (the
//                                     equivalent of model_settings.config)
//
// The caller supplies the byte source (S3 ranged GETs in production, an
// in-memory buffer in tests) — see src/lib/threemf-remote.ts for the S3 side.

import { inflateSync } from "fflate";
import type { PrinterInfo } from "@/db/schema";
import { bedSizeForModel } from "@/lib/printer-beds";

export type SliceInfo = {
  plateCount: number;
  // Sums over all plates; null for unsliced files (no predictions).
  printTimeSeconds: number | null;
  filamentGrams: number | null;
};

export type SliceData = {
  sliceInfo: SliceInfo | null;
  printerInfo: PrinterInfo | null;
};

// Reads bytes [start, end] — both inclusive, like an HTTP Range header.
export type RangeReader = (start: number, end: number) => Promise<Uint8Array>;

const MODEL_SETTINGS_PATH = "metadata/model_settings.config";
const SLICE_INFO_PATH = "metadata/slice_info.config";
const PROJECT_SETTINGS_PATH = "metadata/project_settings.config";
const PRUSA_CONFIG_PATH = "metadata/slic3r_pe.config";
const PRUSA_MODEL_PATH = "metadata/slic3r_pe_model.config";
const WANTED_ENTRIES = new Set([
  MODEL_SETTINGS_PATH,
  SLICE_INFO_PATH,
  PROJECT_SETTINGS_PATH,
  PRUSA_CONFIG_PATH,
  PRUSA_MODEL_PATH,
]);
const PLATE_PNG_RE = /^metadata\/plate_\d+\.png$/;

const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

// End-of-central-directory record: 22 fixed bytes + up to 64 KB comment.
const TAIL_BYTES = 22 + 0xffff;
// The config entries are a few KB — anything huge is not what we expect.
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;

function viewOf(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// Locates the central directory from the archive tail. Handles ZIP64 offsets:
// with a 1 GB upload cap the ZIP64 EOCD record always sits inside the tail.
function findCentralDirectory(
  tail: Uint8Array,
): { offset: number; size: number } | null {
  const view = viewOf(tail);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) !== EOCD_SIG) continue;
    const size = view.getUint32(i + 12, true);
    const offset = view.getUint32(i + 16, true);
    if (offset !== 0xffffffff && size !== 0xffffffff) return { offset, size };
    for (let j = i - 56; j >= 0; j--) {
      if (view.getUint32(j, true) !== ZIP64_EOCD_SIG) continue;
      return {
        size: Number(view.getBigUint64(j + 40, true)),
        offset: Number(view.getBigUint64(j + 48, true)),
      };
    }
    return null;
  }
  return null;
}

type CentralEntry = {
  method: number;
  compressedSize: number;
  localOffset: number;
};

function scanCentralDirectory(cd: Uint8Array) {
  const view = viewOf(cd);
  const decoder = new TextDecoder();
  const entries = new Map<string, CentralEntry>();
  let platePngCount = 0;
  let i = 0;
  while (i + 46 <= cd.length && view.getUint32(i, true) === CENTRAL_SIG) {
    const nameLen = view.getUint16(i + 28, true);
    const extraLen = view.getUint16(i + 30, true);
    const commentLen = view.getUint16(i + 32, true);
    const name = decoder
      .decode(cd.subarray(i + 46, i + 46 + nameLen))
      .toLowerCase();
    if (WANTED_ENTRIES.has(name)) {
      entries.set(name, {
        method: view.getUint16(i + 10, true),
        compressedSize: view.getUint32(i + 20, true),
        localOffset: view.getUint32(i + 42, true),
      });
    } else if (PLATE_PNG_RE.test(name)) {
      platePngCount++;
    }
    i += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, platePngCount };
}

async function readEntry(readRange: RangeReader, entry: CentralEntry) {
  // Name/extra lengths in the local header can differ from the central
  // directory copy, so read them from the local header itself.
  const header = viewOf(
    await readRange(entry.localOffset, entry.localOffset + 29),
  );
  if (header.getUint32(0, true) !== LOCAL_SIG) return null;
  const dataStart =
    entry.localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const raw = await readRange(dataStart, dataStart + entry.compressedSize - 1);
  return new TextDecoder().decode(entry.method === 8 ? inflateSync(raw) : raw);
}

function countPlates(xml: string) {
  return (xml.match(/<plate>/g) ?? []).length;
}

function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim().slice(0, 80);
  return label || undefined;
}

// The filament slots the objects are actually assigned to (the model config's
// per-object/per-part `extruder` keys, 1-based) — an AMS project may park 5
// filaments while everything prints with one, and PrusaSlicer writes an entry
// per physical extruder whether or not it is used. Falls back to the first slot
// when the archive carries no assignment.
function usedFilamentSlots(modelXml: string | null): number[] {
  const used = new Set<number>();
  for (const m of modelXml?.matchAll(/key="extruder"\s+value="(\d+)"/g) ?? []) {
    // PrusaSlicer writes 0 on parts that inherit their object's extruder.
    if (Number(m[1]) > 0) used.add(Number(m[1]));
  }
  return used.size > 0 ? [...used].sort((a, b) => a - b) : [1];
}

// Both slicers spell filament colours "#RRGGBB" (Bambu sometimes appends an
// alpha pair, which a swatch doesn't need).
const HEX_COLOR_RE = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i;

function hexColor(value: unknown): string | undefined {
  const m = HEX_COLOR_RE.exec(String(value ?? "").trim());
  return m ? `#${m[1].toLowerCase()}` : undefined;
}

type UsedFilaments = {
  slots: number[]; // 1-based indices into the config's per-slot arrays
  types: string[]; // parallel to slots
  colors?: string[]; // parallel to slots, or absent when any slot lacks one
};

// The filaments the print actually uses, one entry per slot. Types are *not*
// deduped: two slots of the same material in different colours is a two-colour
// print, and collapsing it to ["PLA"] loses exactly the distinction the badges
// exist to show. Colours are all-or-nothing so the arrays always zip 1:1.
function usedFilaments(
  slots: number[],
  types: unknown,
  colors: unknown,
): UsedFilaments | null {
  if (!Array.isArray(types)) return null;
  const used: UsedFilaments = { slots: [], types: [] };
  for (const slot of slots) {
    const type = cleanLabel(types[slot - 1]);
    if (type === undefined) continue;
    used.slots.push(slot);
    used.types.push(type);
  }
  if (used.types.length === 0) return null;
  const hexes = used.slots
    .map((slot) => hexColor(Array.isArray(colors) ? colors[slot - 1] : undefined))
    .filter((c): c is string => c !== undefined);
  if (hexes.length === used.slots.length) used.colors = hexes;
  return used;
}

// Per-extruder numeric settings — Bambu writes an array (one entry per physical
// extruder), PrusaSlicer a comma-joined string the caller splits. Kept
// positional, with unparseable entries as undefined, because the index *is* the
// extruder number.
function numberList(value: unknown): (number | undefined)[] {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  return raw.map((v) => {
    const parsed = Number.parseFloat(String(v));
    return Number.isFinite(parsed) ? parsed : undefined;
  });
}

// Both slicers spell booleans as "0"/"1" (Bambu wraps per-extruder settings in
// an array, PrusaSlicer writes a bare ini value). Anything else — including a
// missing key — is "the config doesn't say", not "false".
function boolSetting(value: unknown): boolean | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw === "boolean") return raw;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return undefined;
}

// Both slicers describe the bed as a polygon of "XxY" mm points — Bambu/Orca as
// a `printable_area` array, PrusaSlicer as a comma-joined `bed_shape` string. We
// only need the plate size, so we take the polygon's bounding box (which also
// gives a sane square for circular/delta beds). Returns undefined for missing,
// malformed, or implausibly sized shapes so callers can fall back.
const BED_POINT_RE = /^\s*(-?[\d.]+)\s*x\s*(-?[\d.]+)\s*$/i;

function bedSizeFromPoints(points: unknown): { x: number; y: number } | undefined {
  if (!Array.isArray(points) || points.length < 3) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pt of points) {
    const m = BED_POINT_RE.exec(String(pt));
    if (!m) return undefined;
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const x = Math.round(maxX - minX);
  const y = Math.round(maxY - minY);
  // Reject degenerate / implausible plates: real FDM beds run from ~120 mm
  // hobby printers up to large-format machines, comfortably inside this range.
  if (x < 20 || y < 20 || x > 2000 || y > 2000) return undefined;
  return { x, y };
}

function printerInfoFromBambu(
  settings: Record<string, unknown>,
  modelXml: string | null,
): PrinterInfo | null {
  const model =
    cleanLabel(settings.printer_model) ?? cleanLabel(settings.printer_settings_id);
  const filaments = usedFilaments(
    usedFilamentSlots(modelXml),
    settings.filament_type,
    settings.filament_colour, // British spelling, in both slicers
  );
  const nozzles = numberList(settings.nozzle_diameter);
  // `filament_map` assigns each slot to a physical extruder (1-based); Bambu/
  // Orca only writes it for dual-nozzle machines. Without it, a print using a
  // single slot needs a single nozzle either way, and a lone nozzle_diameter
  // entry proves the machine only has one — anything else is unknowable.
  const map = numberList(settings.filament_map);
  const usedExtruders = !filaments
    ? undefined
    : map.length > 0
      ? [...new Set(filaments.slots.map((slot) => map[slot - 1] ?? 1))].sort(
          (a, b) => a - b,
        )
      : filaments.slots.length === 1 || nozzles.length === 1
        ? [1]
        : undefined;
  const info: PrinterInfo = {
    model,
    // One nozzle_diameter entry per physical extruder: report the nozzle the
    // objects actually print from, not just the first one on the machine.
    nozzleDiameterMm: nozzles[(usedExtruders?.[0] ?? 1) - 1] ?? nozzles[0],
    bedType: cleanLabel(settings.curr_bed_type),
    filamentTypes: filaments?.types,
    filamentColors: filaments?.colors,
    requiresMultiNozzle: usedExtruders && usedExtruders.length > 1,
    usesSupport: boolSetting(settings.enable_support),
    bedSizeMm: bedSizeFromPoints(settings.printable_area) ?? bedSizeForModel(model),
  };
  return Object.values(info).some((v) => v !== undefined) ? info : null;
}

function printerInfoFromPrusaIni(
  ini: string,
  modelXml: string | null,
): PrinterInfo | null {
  const values = new Map<string, string>();
  for (const line of ini.split("\n")) {
    const m = line.match(/^\s*([a-z_0-9]+)\s*=\s*(.*)$/);
    if (m) values.set(m[1], m[2].trim());
  }
  const model =
    cleanLabel(values.get("printer_model")) ??
    cleanLabel(values.get("printer_settings_id"));
  const filaments = usedFilaments(
    usedFilamentSlots(modelXml),
    values.get("filament_type")?.split(";"),
    values.get("filament_colour")?.split(";"),
  );
  const nozzles = numberList(values.get("nozzle_diameter")?.split(","));
  // PrusaSlicer says it outright: single_extruder_multi_material is an MMU-style
  // multiplexer feeding one nozzle, so only a multi-slot print *without* that
  // flag needs a real toolchanger (Prusa XL, IDEX).
  const semm = boolSetting(values.get("single_extruder_multi_material"));
  const usedExtruders = !filaments
    ? undefined
    : filaments.slots.length === 1 || nozzles.length === 1 || semm === true
      ? [1]
      : semm === false
        ? filaments.slots
        : undefined;
  const info: PrinterInfo = {
    model,
    nozzleDiameterMm: nozzles[(usedExtruders?.[0] ?? 1) - 1] ?? nozzles[0],
    filamentTypes: filaments?.types,
    filamentColors: filaments?.colors,
    requiresMultiNozzle: usedExtruders && usedExtruders.length > 1,
    // support_material is the master switch; support_material_auto only picks
    // "everywhere" vs "painted enforcers only" — either way the print has
    // supports, so it doesn't change the answer.
    usesSupport: boolSetting(values.get("support_material")),
    bedSizeMm:
      bedSizeFromPoints(values.get("bed_shape")?.split(",")) ??
      bedSizeForModel(model),
  };
  return Object.values(info).some((v) => v !== undefined) ? info : null;
}

// Returns null for archives without the relevant metadata (plain core-spec
// 3mf, non-3mf input).
export async function readSliceData(
  readRange: RangeReader,
  size: number,
): Promise<SliceData | null> {
  const tail = await readRange(Math.max(0, size - TAIL_BYTES), size - 1);
  const cd = findCentralDirectory(tail);
  if (!cd || cd.size === 0) return null;

  const { entries, platePngCount } = scanCentralDirectory(
    await readRange(cd.offset, cd.offset + cd.size - 1),
  );
  const entryText = async (name: string) => {
    const entry = entries.get(name);
    return entry && entry.compressedSize > 0 && entry.compressedSize <= MAX_ENTRY_BYTES
      ? await readEntry(readRange, entry)
      : null;
  };

  const modelXml = await entryText(MODEL_SETTINGS_PATH);

  let printTimeSeconds: number | null = null;
  let filamentGrams: number | null = null;
  let plateCount = 0;
  const sliceXml = await entryText(SLICE_INFO_PATH);
  if (sliceXml) {
    plateCount = countPlates(sliceXml);
    for (const match of sliceXml.matchAll(/key="prediction"\s+value="(\d+)"/g)) {
      printTimeSeconds = (printTimeSeconds ?? 0) + Number(match[1]);
    }
    for (const match of sliceXml.matchAll(/key="weight"\s+value="([\d.]+)"/g)) {
      filamentGrams = (filamentGrams ?? 0) + Number(match[1]);
    }
  }
  // Unsliced project files have an empty slice_info.config but still define
  // their plates in model_settings.config.
  if (plateCount === 0 && modelXml) plateCount = countPlates(modelXml);
  if (plateCount === 0) plateCount = platePngCount;
  const sliceInfo =
    plateCount > 0 ? { plateCount, printTimeSeconds, filamentGrams } : null;

  let printerInfo: PrinterInfo | null = null;
  const projectJson = await entryText(PROJECT_SETTINGS_PATH);
  if (projectJson) {
    try {
      printerInfo = printerInfoFromBambu(JSON.parse(projectJson), modelXml);
    } catch {
      // not JSON — ignore
    }
  }
  if (!printerInfo) {
    const ini = await entryText(PRUSA_CONFIG_PATH);
    // PrusaSlicer keeps its per-object extruders in its own model config, not
    // in Bambu's model_settings.config.
    if (ini) {
      printerInfo = printerInfoFromPrusaIni(
        ini,
        await entryText(PRUSA_MODEL_PATH),
      );
    }
  }

  if (!sliceInfo && !printerInfo) return null;
  return { sliceInfo, printerInfo };
}
