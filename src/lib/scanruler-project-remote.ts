// ScanRuler project summaries for files already in storage: wires the pure
// reader (scanruler-project.ts) to ranged blob reads and caches per key, the
// same split as threemf-remote.ts.

import { readBlobBytes } from "@/lib/blob-store";
import { blobStore } from "@/lib/storage";
import {
  readScanRulerProjectSummary,
  type ScanRulerProjectSummary,
} from "@/lib/scanruler-project";
import { reportError } from "@/lib/telemetry";

// Uploaded objects are immutable, so a summary can be cached by key.
const cache = new Map<string, ScanRulerProjectSummary | null>();

// Null for anything that isn't a readable ScanRuler project; the row then just
// shows the file. A storage error is reported and not cached.
export async function getScanRulerProjectSummary(
  s3Key: string,
  size: number,
): Promise<ScanRulerProjectSummary | null> {
  const cached = cache.get(s3Key);
  if (cached !== undefined) return cached;
  try {
    const summary = await readScanRulerProjectSummary(async (start, end) => {
      const bytes = await readBlobBytes(blobStore(), s3Key, { start, end });
      if (!bytes) throw new Error("stored object missing");
      return bytes;
    }, size);
    cache.set(s3Key, summary);
    return summary;
  } catch (err) {
    reportError("Reading ScanRuler project summary failed", err);
    return null;
  }
}
