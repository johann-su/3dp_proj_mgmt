// Client-side extraction of metadata from .3mf files (which are ZIP archives).
//
// Sources, in order of usefulness:
// - 3D/3dmodel.model            core spec XML: <metadata name="Title|Description">
// - Metadata/project_settings.config  Bambu Studio JSON: printer profile name
// - Metadata/slice_info.config  Bambu Studio XML: printer_model_id code
// - Metadata/plate_*.png        Bambu plate previews
// - Metadata/thumbnail*.png     PrusaSlicer / generic thumbnails
// - Auxiliaries/**              Makerworld project pictures

import { unzip, type Unzipped, type UnzipFileInfo } from "fflate";

export type ThreeMfMetadata = {
  title?: string;
  description?: string;
  printerTag?: string;
  images: File[];
};

// Geometry XML can be huge; skip metadata parsing on absurdly large entries.
const MAX_MODEL_XML_BYTES = 64 * 1024 * 1024;
const METADATA_SCAN_BYTES = 256 * 1024;
const MAX_IMAGES = 8;

// Bambu Studio slice_info.config printer_model_id codes
const BAMBU_MODEL_IDS: Record<string, string> = {
  "BL-P001": "X1C",
  "BL-P002": "X1",
  C11: "P1P",
  C12: "P1S",
  C13: "X1E",
  N1: "A1 mini",
  N2S: "A1",
};

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

function isPlatePreview(lower: string) {
  return /^metadata\/plate_\d+\.png$/.test(lower);
}

function isThumbnail(lower: string) {
  return /^metadata\/thumbnail[^/]*\.png$/.test(lower);
}

function isAuxiliaryPicture(lower: string) {
  return (
    lower.startsWith("auxiliaries/") &&
    !lower.includes("/.thumbnails/") &&
    !lower.includes("profile picture") && // uploader avatar, not model imagery
    extensionOf(lower) in IMAGE_MIME
  );
}

function wanted(file: UnzipFileInfo) {
  const lower = file.name.toLowerCase();
  if (lower === "3d/3dmodel.model") {
    return file.originalSize <= MAX_MODEL_XML_BYTES;
  }
  return (
    lower === "metadata/project_settings.config" ||
    lower === "metadata/slice_info.config" ||
    isPlatePreview(lower) ||
    isThumbnail(lower) ||
    isAuxiliaryPicture(lower)
  );
}

function unzipWanted(data: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    unzip(data, { filter: wanted }, (err, files) =>
      err ? reject(err) : resolve(files),
    );
  });
}

function decodeEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

// Bambu Studio double-escapes the Description metadata and stores HTML in it
// (e.g. "&amp;lt;h3&amp;gt;..."). Decode until stable, then flatten to text.
function htmlishToText(raw: string): string {
  let text = raw;
  for (let i = 0; i < 4; i++) {
    const decoded = decodeEntities(text);
    if (decoded === text) break;
    text = decoded;
  }
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function coreMetadata(xmlHead: string, name: string): string | undefined {
  const match = xmlHead.match(
    new RegExp(`<metadata\\s+name="${name}"[^>]*>([\\s\\S]*?)</metadata>`, "i"),
  );
  const value = match ? htmlishToText(match[1]) : "";
  return value || undefined;
}

// "Bambu_P1S_AMS_Flipper_V1.4.3mf" -> "Bambu P1S AMS Flipper V1.4"
function titleFromFilename(filename: string) {
  return filename
    .replace(/\.3mf$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "Bambu Lab P1S 0.4 nozzle" -> "bambu p1s", "Bambu Lab X1 Carbon" -> "bambu x1c"
function printerTagFromName(raw: string): string {
  let name = raw.replace(/\s+\d+(\.\d+)?\s*nozzle\s*$/i, "").trim();
  name = name.replace(/^bambu\s+lab\s+/i, "Bambu ");
  name = name.replace(/x1\s*carbon/i, "X1C");
  return name.toLowerCase();
}

export async function extract3mfMetadata(file: File): Promise<ThreeMfMetadata> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const entries = await unzipWanted(buffer);
  const decoder = new TextDecoder();

  const byLowerName = new Map(
    Object.entries(entries).map(([name, data]) => [name.toLowerCase(), { name, data }]),
  );

  let title: string | undefined;
  let description: string | undefined;
  const modelXml = byLowerName.get("3d/3dmodel.model");
  if (modelXml) {
    // The <metadata> block sits at the top of the document, before the
    // (potentially enormous) geometry — only decode the head.
    const head = decoder.decode(modelXml.data.subarray(0, METADATA_SCAN_BYTES));
    title = coreMetadata(head, "Title");
    description = coreMetadata(head, "Description");
  }
  // Bambu Studio doesn't write a Title metadata — fall back to the filename.
  title ??= titleFromFilename(file.name) || undefined;

  let printerTag: string | undefined;
  const projectSettings = byLowerName.get("metadata/project_settings.config");
  if (projectSettings) {
    try {
      const settings = JSON.parse(decoder.decode(projectSettings.data));
      const printerName = settings.printer_model ?? settings.printer_settings_id;
      if (typeof printerName === "string" && printerName.trim()) {
        printerTag = printerTagFromName(printerName);
      }
    } catch {
      // not JSON (other slicers) — ignore
    }
  }
  if (!printerTag) {
    const sliceInfo = byLowerName.get("metadata/slice_info.config");
    if (sliceInfo) {
      const match = decoder
        .decode(sliceInfo.data)
        .match(/key="printer_model_id"\s+value="([^"]+)"/i);
      const model = match && BAMBU_MODEL_IDS[match[1]];
      if (model) printerTag = `bambu ${model}`.toLowerCase();
    }
  }

  // Auxiliary pictures (Makerworld renders) first, then plate previews, then
  // generic thumbnails.
  const imageEntries = [...byLowerName.entries()]
    .filter(([lower]) => extensionOf(lower) in IMAGE_MIME)
    .sort(([a], [b]) => {
      const rank = (lower: string) =>
        isAuxiliaryPicture(lower) ? 0 : isPlatePreview(lower) ? 1 : 2;
      return rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true });
    })
    .slice(0, MAX_IMAGES);

  const images = imageEntries.map(([lower, { name, data }]) => {
    const basename = name.split("/").pop() ?? name;
    return new File([data as BlobPart], basename, { type: IMAGE_MIME[extensionOf(lower)] });
  });

  return { title, description, printerTag, images };
}
