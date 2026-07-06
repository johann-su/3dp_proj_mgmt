import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBytes, formatDuration, formatGrams } from "@/lib/format";

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
