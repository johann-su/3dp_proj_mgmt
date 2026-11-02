import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanRulerBase,
  scanRulerCorsHeaders,
  scanRulerOpenUrl,
  scanRulerOpens,
} from "@/lib/scanruler";

test("scanRulerBase: unset or non-http disables the feature", () => {
  assert.equal(scanRulerBase(undefined), null);
  assert.equal(scanRulerBase("  "), null);
  assert.equal(scanRulerBase("not a url"), null);
  assert.equal(scanRulerBase("javascript:alert(1)"), null);
});

test("scanRulerBase normalizes to the app's index, dropping query and hash", () => {
  assert.equal(scanRulerBase("https://scanruler.com"), "https://scanruler.com/");
  // A self-hosted build under a sub-path keeps its path.
  assert.equal(
    scanRulerBase("https://tools.example.com/scanruler?x=1#y"),
    "https://tools.example.com/scanruler/",
  );
});

test("scanRulerOpenUrl carries the file URL and workspace as query params", () => {
  const fileUrl = "https://vault.example.com/api/files/abc/123.sig/Bracket v2.3mf";
  const link = new URL(scanRulerOpenUrl("https://scanruler.com/", fileUrl, "reverse"));
  assert.equal(link.origin + link.pathname, "https://scanruler.com/");
  // Round-trips exactly: ScanRuler names the file after its last path segment.
  assert.equal(link.searchParams.get("open"), fileUrl);
  assert.equal(link.searchParams.get("workspace"), "reverse");
});

test("scanRulerOpens: meshes, STEP and ScanRuler projects, not OpenSCAD source", () => {
  assert.equal(scanRulerOpens("part.3MF"), true);
  assert.equal(scanRulerOpens("part.step"), true);
  assert.equal(scanRulerOpens("part.stp"), true);
  assert.equal(scanRulerOpens("scan.scanruler"), true);
  assert.equal(scanRulerOpens("box.scad"), false);
});

test("CORS is granted only to the configured ScanRuler origin", () => {
  const base = "https://scanruler.com/";
  assert.deepEqual(scanRulerCorsHeaders("https://scanruler.com", base), {
    "Access-Control-Allow-Origin": "https://scanruler.com",
    Vary: "Origin",
  });
  // Look-alike hosts, other schemes and no Origin get nothing.
  assert.equal(scanRulerCorsHeaders("https://scanruler.com.evil.example", base), null);
  assert.equal(scanRulerCorsHeaders("http://scanruler.com", base), null);
  assert.equal(scanRulerCorsHeaders(null, base), null);
  // Feature off: never CORS.
  assert.equal(scanRulerCorsHeaders("https://scanruler.com", null), null);
});
