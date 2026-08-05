import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatBytes,
  formatClock,
  formatDate,
  formatDuration,
  formatGrams,
} from "@/lib/format";

test("formatBytes uses B/KB/MB/GB with sensible precision", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  // >= 10 in a unit drops the decimal
  assert.equal(formatBytes(20 * 1024), "20 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), "3.0 GB");
});

test("formatDuration rounds to minutes and splits hours", () => {
  assert.equal(formatDuration(540), "9 min");
  assert.equal(formatDuration(5460), "1 h 31 min");
  assert.equal(formatDuration(3600), "1 h");
  // never shows "0 min" for a non-zero duration
  assert.equal(formatDuration(20), "1 min");
});

test("formatGrams keeps a decimal only below 10 g", () => {
  assert.equal(formatGrams(3.72), "3.7 g");
  assert.equal(formatGrams(25.4), "25 g");
  assert.equal(formatGrams(0), "0.1 g");
});

test("formatDate is pinned to UTC regardless of the host timezone", () => {
  // model-view.tsx renders this in a "use client" component that's both
  // server- and client-rendered; a timestamp near midnight UTC would format
  // to different calendar days on a UTC server vs. a UTC+ browser (or vice
  // versa) if the zone weren't fixed, tripping a React hydration mismatch.
  assert.equal(formatDate(new Date("2026-07-06T23:30:00Z")), "Jul 6, 2026");
});

// The gallery video player's clock. Unlike formatDuration (which rounds to
// "1 h 31 min" for print estimates) this shows the exact second, because it
// tracks a playhead.
test("formatClock pads seconds and only shows hours when there are some", () => {
  assert.equal(formatClock(4), "0:04");
  assert.equal(formatClock(65), "1:05");
  assert.equal(formatClock(600), "10:00");
  // Past an hour the minutes field pads too, so 1:02:05 can't read as 1:2:05.
  assert.equal(formatClock(3725), "1:02:05");
});

// A <video> reports NaN duration until metadata loads and Infinity for a
// stream; neither may render as "NaN:aN" in the control bar.
test("formatClock renders a placeholder for durations that aren't a number", () => {
  assert.equal(formatClock(NaN), "0:00");
  assert.equal(formatClock(Infinity), "0:00");
  assert.equal(formatClock(-5), "0:00");
  // Sub-second playback positions floor to 0:00 rather than rounding up.
  assert.equal(formatClock(0.4), "0:00");
});
