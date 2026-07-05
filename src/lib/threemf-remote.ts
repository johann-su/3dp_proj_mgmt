// Server-side extraction of Bambu slice info (plate count, print time) from
// .3mf files already stored in S3. A .3mf can be up to 1 GB, so instead of
// downloading the archive we read the ZIP central directory via ranged GETs
// and fetch only the tiny Bambu Studio config entries:
//
// - Metadata/model_settings.config  one <plate> block per plate, present even
//                                   in unsliced project files
// - Metadata/slice_info.config      <metadata key="prediction" value="<s>"/>
//                                   per plate, only once the file was sliced

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { inflateSync } from "fflate";
import { s3, S3_BUCKET } from "@/lib/s3";

export type SliceInfo = {
  plateCount: number;
  // Sum over all plates; null for unsliced files (no time predictions).
  printTimeSeconds: number | null;
};

const MODEL_SETTINGS_PATH = "metadata/model_settings.config";
const SLICE_INFO_PATH = "metadata/slice_info.config";
const PLATE_PNG_RE = /^metadata\/plate_\d+\.png$/;

const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

// End-of-central-directory record: 22 fixed bytes + up to 64 KB comment.
const TAIL_BYTES = 22 + 0xffff;
// The config entries are a few KB — anything huge is not what we expect.
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;

// Uploaded objects are immutable, so parse results can be cached by key.
const cache = new Map<string, SliceInfo | null>();

async function getRange(key: string, start: number, end: number) {
  const object = await s3.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Range: `bytes=${start}-${end}`,
    }),
  );
  if (!object.Body) throw new Error("empty range response");
  return object.Body.transformToByteArray();
}

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
    if (name === MODEL_SETTINGS_PATH || name === SLICE_INFO_PATH) {
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

async function readEntry(key: string, entry: CentralEntry) {
  // Name/extra lengths in the local header can differ from the central
  // directory copy, so read them from the local header itself.
  const header = viewOf(
    await getRange(key, entry.localOffset, entry.localOffset + 29),
  );
  if (header.getUint32(0, true) !== LOCAL_SIG) return null;
  const dataStart =
    entry.localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const raw = await getRange(key, dataStart, dataStart + entry.compressedSize - 1);
  return new TextDecoder().decode(entry.method === 8 ? inflateSync(raw) : raw);
}

function countPlates(xml: string) {
  return (xml.match(/<plate>/g) ?? []).length;
}

async function read(key: string, size: number): Promise<SliceInfo | null> {
  const tail = await getRange(key, Math.max(0, size - TAIL_BYTES), size - 1);
  const cd = findCentralDirectory(tail);
  if (!cd || cd.size === 0) return null;

  const { entries, platePngCount } = scanCentralDirectory(
    await getRange(key, cd.offset, cd.offset + cd.size - 1),
  );
  const readable = (name: string) => {
    const entry = entries.get(name);
    return entry && entry.compressedSize > 0 && entry.compressedSize <= MAX_ENTRY_BYTES
      ? entry
      : undefined;
  };

  let printTimeSeconds: number | null = null;
  let plateCount = 0;
  const sliceEntry = readable(SLICE_INFO_PATH);
  if (sliceEntry) {
    const xml = await readEntry(key, sliceEntry);
    if (xml) {
      plateCount = countPlates(xml);
      for (const match of xml.matchAll(/key="prediction"\s+value="(\d+)"/g)) {
        printTimeSeconds = (printTimeSeconds ?? 0) + Number(match[1]);
      }
    }
  }
  // Unsliced project files have an empty slice_info.config but still define
  // their plates in model_settings.config.
  if (plateCount === 0) {
    const settingsEntry = readable(MODEL_SETTINGS_PATH);
    if (settingsEntry) {
      const xml = await readEntry(key, settingsEntry);
      if (xml) plateCount = countPlates(xml);
    }
  }
  if (plateCount === 0) plateCount = platePngCount;
  if (plateCount === 0) return null;

  return { plateCount, printTimeSeconds };
}

// Returns null for non-Bambu archives (no plate information at all) or on any
// S3/parse error — callers just omit the info line.
export async function get3mfSliceInfo(
  s3Key: string,
  size: number,
): Promise<SliceInfo | null> {
  const cached = cache.get(s3Key);
  if (cached !== undefined) return cached;
  let info: SliceInfo | null = null;
  try {
    info = await read(s3Key, size);
  } catch {
    // unreachable object or malformed archive — treat as "no info"
  }
  cache.set(s3Key, info);
  return info;
}
