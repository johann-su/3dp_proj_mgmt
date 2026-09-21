import { test } from "node:test";
import assert from "node:assert/strict";
import { GcodeStatsWindow, parseGcodeStats } from "@/lib/gcode-stats";

const encoder = new TextEncoder();

test("reads PrusaSlicer/OrcaSlicer footer stats", () => {
  const { printTimeSeconds, filamentGrams } = parseGcodeStats(
    [
      "; estimated printing time (normal mode) = 1h 31m 12s",
      "; total filament used [g] = 24.53",
    ].join("\n"),
  );
  assert.equal(printTimeSeconds, 5472);
  assert.equal(filamentGrams, 24.53);
});

test("reads Bambu Studio's spelling of the same two numbers", () => {
  // Bambu writes `key: value` where PrusaSlicer writes `key = value`, and puts
  // a space before the colon on the weight line. A push from Bambu Studio is
  // a first-class case, so both dialects have to parse.
  const { printTimeSeconds, filamentGrams } = parseGcodeStats(
    ["; total estimated time: 2h 5m", "; total filament weight [g] : 18.2"].join(
      "\n",
    ),
  );
  assert.equal(printTimeSeconds, 7500);
  assert.equal(filamentGrams, 18.2);
});

test("multi-extruder filament lines are summed, not truncated", () => {
  // A multi-material print writes one comma-separated value per extruder;
  // reporting only the first would under-report the whole print.
  const { filamentGrams } = parseGcodeStats(
    "; total filament used [g] = 10.5, 4.25, 0",
  );
  assert.equal(filamentGrams, 14.75);
});

test("the stealth-mode second estimate is ignored", () => {
  // PrusaSlicer emits a second line for stealth mode; the normal-mode number
  // comes first and is the one the UI shows.
  const { printTimeSeconds } = parseGcodeStats(
    [
      "; estimated printing time (normal mode) = 1h 0m 0s",
      "; estimated printing time (stealth mode) = 2h 0m 0s",
    ].join("\n"),
  );
  assert.equal(printTimeSeconds, 3600);
});

test("a footer with no stats yields nulls, never zeroes", () => {
  // "We don't know" and "this print takes no time" must stay distinguishable —
  // the model page hides a null estimate but would render a 0 as a real value.
  const stats = parseGcodeStats("G1 X10 Y10 E1\n; nothing useful here\n");
  assert.equal(stats.printTimeSeconds, null);
  assert.equal(stats.filamentGrams, null);
});

test("Bambu/Orca put both times on one line; the total is taken, not the sum", () => {
  // Verified against OrcaSlicer 2.5 output for a P1S, where line 3 reads
  // exactly this. A capture that ran to end-of-line would hand the duration
  // parser both values and report 9h 53m for a 5h print — and "total
  // estimated" is the number the slicer's own UI and slice_info.config's
  // `prediction` field agree on.
  const { printTimeSeconds } = parseGcodeStats(
    "; model printing time: 4h 53m 23s; total estimated time: 5h 0m 4s\n",
  );
  assert.equal(printTimeSeconds, 18004);
});

test("a stats window keeps both ends of the stream", () => {
  // Which end carries the numbers depends on the slicer: PrusaSlicer writes
  // them in the footer, Bambu/Orca write the print time in the header (line 3
  // of an 8 MB file) and the filament totals at the end. A tail-only scan
  // silently loses the print time of every Bambu-printer push.
  const scan = new GcodeStatsWindow(64, 64);
  scan.push(encoder.encode("; total estimated time: 1h 0m 0s\n"));
  scan.push(encoder.encode("G1 X10 Y10 E1\n".repeat(500)));
  scan.push(encoder.encode("; total filament used [g] = 7.5\n"));
  const text = scan.text();
  // The 7 KB of moves in between is never held.
  assert.ok(text.length < 200);
  const stats = parseGcodeStats(text);
  assert.equal(stats.printTimeSeconds, 3600);
  assert.equal(stats.filamentGrams, 7.5);
});

test("a stats window spans a stat line split across chunk boundaries", () => {
  // Chunk boundaries fall wherever the network put them — a value cut in half
  // by one must still parse once the window is joined back up.
  const scan = new GcodeStatsWindow(0, 1024);
  for (const chunk of ["; estimated prin", "ting time = 45m", " 30s\n"]) {
    scan.push(encoder.encode(chunk));
  }
  assert.equal(parseGcodeStats(scan.text()).printTimeSeconds, 2730);
});
