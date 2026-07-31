// Print time and filament use as written into a G-code file's footer by the
// slicer that produced it (issue #122: slice-push ingests real G-code exported
// from the user's own OrcaSlicer/Bambu Studio/PrusaSlicer).
//
// There is a sibling of this parser in slicer/lib.mjs, and they are
// deliberately NOT shared: that one runs inside the slicer service container
// (a separate deployable with no build step) and only ever reads G-code our
// own PrusaSlicer CLI just produced, so it can assume PrusaSlicer's spelling.
// This one reads whatever a user's slicer exported, so it also has to know
// Bambu Studio's — and it must keep working on instances with no SLICER_URL
// at all ("optional services degrade to off").
//
// Pure: callers hand it the decoded tail of the file. Everything a slicer
// writes here lives in the last few KB, after the last extrusion move.

// How much of the file's tail to keep. Bambu/Orca append a full config dump
// after the stats, which runs to tens of KB — 128 KB clears it comfortably
// while staying small enough to hold in memory per request.
export const GCODE_TAIL_BYTES = 128 * 1024;

export type GcodeStats = {
  printTimeSeconds: number | null;
  filamentGrams: number | null;
};

const UNIT_SECONDS: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };

// "2d 1h 5m 30s" -> seconds. Returns null when nothing parsed, so a footer
// with an empty/garbled value reads as "no estimate" rather than 0.
function parseDuration(text: string): number | null {
  let seconds: number | null = null;
  for (const m of text.matchAll(/(\d+)\s*([dhms])/g)) {
    seconds = (seconds ?? 0) + Number(m[1]) * UNIT_SECONDS[m[2]];
  }
  return seconds;
}

// Multi-extruder values are comma-separated lists -> sum them.
function sumList(raw: string): number | null {
  let total: number | null = null;
  for (const part of raw.split(",")) {
    const value = Number.parseFloat(part);
    if (Number.isFinite(value)) total = (total ?? 0) + value;
  }
  return total;
}

// The two slicer families spell every one of these differently. PrusaSlicer
// (and OrcaSlicer, which inherits its G-code writer) uses `key = value`;
// Bambu Studio uses `key: value`. Order matters only in that the first match
// wins, and the "total" variants are listed first because a multi-extruder
// file carries both a per-extruder and a total line.
const TIME_PATTERNS = [
  // PrusaSlicer/OrcaSlicer. The "(normal mode)" suffix is optional; a second
  // "(stealth mode)" line may follow, and taking the first match ignores it.
  /^; estimated printing time.*?=\s*(.+)$/m,
  // Bambu Studio.
  /^; total estimated time:\s*(.+)$/m,
  /^; model printing time:\s*(.+)$/m,
];

const GRAMS_PATTERNS = [
  /^; total filament used \[g\]\s*=\s*(.+)$/m,
  /^; filament used \[g\]\s*=\s*(.+)$/m,
  // Bambu Studio. Note the space before the colon — that is how it writes it.
  /^; total filament weight \[g\]\s*:\s*(.+)$/m,
  /^; filament weight \[g\]\s*:\s*(.+)$/m,
];

function firstMatch(tail: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const m = tail.match(pattern);
    if (m) return m[1];
  }
  return null;
}

export function parseGcodeStats(tail: string): GcodeStats {
  const time = firstMatch(tail, TIME_PATTERNS);
  const grams = firstMatch(tail, GRAMS_PATTERNS);
  return {
    printTimeSeconds: time ? parseDuration(time) : null,
    filamentGrams: grams ? sumList(grams) : null,
  };
}

// Keeps the last `maxBytes` of a byte stream without ever holding the whole
// file: a pushed G-code is routinely hundreds of MB, and it streams straight
// to S3, so the stats have to be scraped from the bytes on their way past.
export class TailBuffer {
  private chunks: Uint8Array[] = [];
  private length = 0;

  constructor(private readonly maxBytes: number = GCODE_TAIL_BYTES) {}

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.length += chunk.byteLength;
    // Drop whole leading chunks while the ones behind them still cover the
    // window; only trim inside a chunk when it is the sole survivor.
    while (this.chunks.length > 1 && this.length - this.chunks[0].byteLength >= this.maxBytes) {
      this.length -= this.chunks[0].byteLength;
      this.chunks.shift();
    }
    if (this.chunks.length === 1 && this.length > this.maxBytes) {
      this.chunks[0] = this.chunks[0].subarray(this.length - this.maxBytes);
      this.length = this.maxBytes;
    }
  }

  // Latin-1 rather than UTF-8: the window starts at an arbitrary byte offset,
  // so a multi-byte character can be sliced in half. G-code comments are ASCII
  // and every pattern above is ASCII, so decoding byte-per-char cannot corrupt
  // a match the way a replacement character would.
  text(): string {
    const joined = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("latin1").decode(joined);
  }
}
