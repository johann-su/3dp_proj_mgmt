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
// Pure: callers hand it the text of the windows GcodeStatsWindow kept. Which
// end of the file that text comes from depends on the slicer, and getting it
// wrong reads as "this file has no estimate":
//
// - PrusaSlicer (and OrcaSlicer for a non-Bambu printer) writes its stats in
//   the **footer**, after the last extrusion move.
// - Bambu Studio — and OrcaSlicer for a Bambu printer — writes the print time
//   in the **header**, on line 3, and only the filament totals at the end.
//
// So both ends are scanned. Verified against G-code OrcaSlicer 2.5 produced
// for a P1S: `; model printing time: 4h 53m 23s; total estimated time: 5h 0m 4s`
// at byte 83 of an 8 MB file.

// How much of each end to keep. The header block is under 1 KB in practice;
// the tail has to clear the full config dump Bambu/Orca append after the
// stats, which runs to tens of KB.
export const GCODE_HEAD_BYTES = 64 * 1024;
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
// Every capture stops at a `;`, because Bambu/Orca put both of its times on
// **one line** — `; model printing time: 4h 53m 23s; total estimated time: 5h
// 0m 4s` — and a greedy capture would hand parseDuration both, summing them
// into a print that takes twice as long as it does.
const TIME_PATTERNS = [
  // PrusaSlicer/OrcaSlicer. The "(normal mode)" suffix is optional; a second
  // "(stealth mode)" line may follow, and taking the first match ignores it.
  /^; estimated printing time.*?=\s*([^;\n]+)/m,
  // Bambu Studio/OrcaSlicer. "Total estimated" is the number their own UI
  // shows and the one `slice_info.config` stores as `prediction`, so it is
  // preferred over "model printing time" (which excludes heating and changes)
  // and matched even when it is the second clause of that shared line.
  /^;[^\n]*?total estimated time:\s*([^;\n]+)/m,
  /^; model printing time:\s*([^;\n]+)/m,
];

const GRAMS_PATTERNS = [
  /^; total filament used \[g\]\s*=\s*([^;\n]+)/m,
  /^; filament used \[g\]\s*=\s*([^;\n]+)/m,
  // Bambu Studio. Note the space before the colon — that is how it writes it.
  /^; total filament weight \[g\]\s*:\s*([^;\n]+)/m,
  /^; filament weight \[g\]\s*:\s*([^;\n]+)/m,
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

// Latin-1 rather than UTF-8: a window starts and ends at arbitrary byte
// offsets, so a multi-byte character can be sliced in half. G-code comments
// are ASCII and every pattern above is ASCII, so decoding byte-per-char cannot
// corrupt a match the way a replacement character would.
function decode(chunks: Uint8Array[], length: number): string {
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("latin1").decode(joined);
}

// Keeps both ends of a byte stream — the first `headBytes` and the last
// `tailBytes` — without ever holding the whole file: a pushed G-code is
// routinely hundreds of MB and streams straight to S3, so the stats have to be
// scraped from the bytes on their way past. Which end carries them depends on
// the slicer (see above), so both are kept.
export class GcodeStatsWindow {
  private readonly head: Uint8Array[] = [];
  private headLength = 0;
  private tail: Uint8Array[] = [];
  private tailLength = 0;

  constructor(
    private readonly headBytes: number = GCODE_HEAD_BYTES,
    private readonly tailBytes: number = GCODE_TAIL_BYTES,
  ) {}

  push(chunk: Uint8Array): void {
    if (this.headLength < this.headBytes) {
      const room = this.headBytes - this.headLength;
      const slice = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
      this.head.push(slice);
      this.headLength += slice.byteLength;
    }

    this.tail.push(chunk);
    this.tailLength += chunk.byteLength;
    // Drop whole leading chunks while the ones behind them still cover the
    // window; only trim inside a chunk when it is the sole survivor.
    while (this.tail.length > 1 && this.tailLength - this.tail[0].byteLength >= this.tailBytes) {
      this.tailLength -= this.tail[0].byteLength;
      this.tail.shift();
    }
    if (this.tail.length === 1 && this.tailLength > this.tailBytes) {
      this.tail[0] = this.tail[0].subarray(this.tailLength - this.tailBytes);
      this.tailLength = this.tailBytes;
    }
  }

  // Joined with a newline so the seam between the two windows cannot fuse a
  // truncated header line onto a tail line and match as one.
  text(): string {
    return `${decode(this.head, this.headLength)}\n${decode(this.tail, this.tailLength)}`;
  }
}
