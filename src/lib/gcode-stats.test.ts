import { test } from "node:test";
import assert from "node:assert/strict";
import { TailBuffer, parseGcodeStats } from "@/lib/gcode-stats";

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

test("TailBuffer keeps the end of a stream, not the start", () => {
  // The stats sit after the last extrusion move, so a pushed 200 MB G-code is
  // scraped from a small trailing window as the bytes stream past to S3.
  const tail = new TailBuffer(64);
  const moves = "G1 X10 Y10 E1\n".repeat(500);
  tail.push(encoder.encode(moves));
  tail.push(encoder.encode("; total filament used [g] = 7.5\n"));
  const text = tail.text();
  // Only the trailing window is retained, never the whole 7 KB of moves.
  assert.ok(text.length < moves.length);
  assert.equal(parseGcodeStats(text).filamentGrams, 7.5);
});

test("TailBuffer spans a stat line split across chunk boundaries", () => {
  // Chunk boundaries fall wherever the network put them — a value cut in half
  // by one must still parse once the window is joined back up.
  const tail = new TailBuffer(1024);
  for (const chunk of ["; estimated prin", "ting time = 45m", " 30s\n"]) {
    tail.push(encoder.encode(chunk));
  }
  assert.equal(parseGcodeStats(tail.text()).printTimeSeconds, 2730);
});
