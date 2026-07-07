// Slicer metadata for .3mf files already stored in S3. The ZIP/config parsing
// lives in src/lib/threemf-slice-info.ts (pure, unit-tested); this module only
// wires it to S3 ranged GETs and caches the result per object key.

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { s3, S3_BUCKET } from "@/lib/s3";
import {
  readSliceData,
  type SliceData,
  type SliceInfo,
} from "@/lib/threemf-slice-info";
import type { PrinterInfo } from "@/db/schema";

export type { SliceInfo } from "@/lib/threemf-slice-info";

// Uploaded objects are immutable, so parse results can be cached by key.
const cache = new Map<string, SliceData | null>();

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

// Both getters return null for archives without the relevant metadata (plain
// core-spec 3mf, non-3mf uploads) or on any S3/parse error — callers just
// omit the info.
async function parseCached(s3Key: string, size: number): Promise<SliceData | null> {
  const cached = cache.get(s3Key);
  if (cached !== undefined) return cached;
  let parsed: SliceData | null = null;
  try {
    parsed = await readSliceData(
      (start, end) => getRange(s3Key, start, end),
      size,
    );
  } catch {
    // unreachable object or malformed archive — treat as "no info"
  }
  cache.set(s3Key, parsed);
  return parsed;
}

export async function get3mfSliceInfo(
  s3Key: string,
  size: number,
): Promise<SliceInfo | null> {
  return (await parseCached(s3Key, size))?.sliceInfo ?? null;
}

export async function get3mfPrinterInfo(
  s3Key: string,
  size: number,
): Promise<PrinterInfo | null> {
  return (await parseCached(s3Key, size))?.printerInfo ?? null;
}
