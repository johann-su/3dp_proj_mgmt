import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalSourceUrl,
  SOURCES,
  sourceById,
  sourceForUrl,
  supportedSourcesSentence,
} from "@/lib/sources/registry";

const DOC = "0123456789abcdef01234567";
const WS = "0123456789abcdef01234568";

// The sourceUrl allowlist on save: only https links to a known source are stored, with tracking params dropped. The hash stays — on MakerWorld it selects the print profile.
test("canonicalSourceUrl strips tracking params but keeps the hash", () => {
  assert.equal(
    canonicalSourceUrl("https://makerworld.com/en/models/123-thing?from=recommend#profileId-9"),
    "https://makerworld.com/en/models/123-thing#profileId-9",
  );
  assert.equal(canonicalSourceUrl(null), null);
  assert.equal(canonicalSourceUrl(""), null);
});

// undefined means "reject the save" — distinct from null ("no source").
test("canonicalSourceUrl rejects http, unknown and look-alike hosts", () => {
  assert.equal(canonicalSourceUrl("http://makerworld.com/en/models/1"), undefined);
  assert.equal(canonicalSourceUrl("https://example.com/models/1"), undefined);
  assert.equal(canonicalSourceUrl("https://notprintables.com/model/1"), undefined);
  assert.equal(canonicalSourceUrl("not a url"), undefined);
});

// Onshape badges any *.onshape.com page, but only the CAD host can be stored: that is the host sync exports from.
test("Onshape sourceUrls must be on the CAD host", () => {
  assert.equal(sourceForUrl("https://forum.onshape.com/x")?.id, "onshape");
  assert.equal(canonicalSourceUrl("https://forum.onshape.com/x"), undefined);
  assert.equal(
    canonicalSourceUrl(`https://cad.onshape.com/documents/${DOC}/w/${WS}`),
    `https://cad.onshape.com/documents/${DOC}/w/${WS}`,
  );
});

// The smart-collection "source" rule runs the same host test in SQL. Postgres' `~*` is a case-insensitive POSIX regex; for these patterns a JS RegExp with the `i` flag behaves the same, so the two must agree on every sample.
test("each source's SQL host regex agrees with its JS host check", () => {
  const samples = [
    "https://makerworld.com/en/models/1",
    "https://www.printables.com/model/2",
    `https://cad.onshape.com/documents/${DOC}`,
    "https://notprintables.com/model/2",
    "https://makerworld.com.evil.example/models/1",
    "https://example.com/?u=https://makerworld.com/",
  ];
  for (const source of SOURCES) {
    const sql = new RegExp(source.hostSqlRegex, "i");
    for (const sample of samples) {
      assert.equal(
        sql.test(sample),
        source.matchesHost(new URL(sample).hostname),
        `${source.id} disagrees on ${sample}`,
      );
    }
  }
});

// Duplicate detection compares design ids, not URLs: another tab, branch or version pin of the same Onshape document is the same design.
test("an Onshape design id ignores the branch, version and tab pin", () => {
  const onshape = sourceById("onshape");
  const pinned = new URL(`https://cad.onshape.com/documents/${DOC}/v/${WS}/e/${WS}`);
  assert.equal(onshape.designId(pinned), DOC);
  assert.equal(onshape.designId(new URL("https://cad.onshape.com/signin")), null);
});

// The revision token rides in through the client draft, so its format is checked before it is stored; sources without one accept nothing.
test("only sources with a revision format accept a revision token", () => {
  assert.equal(sourceById("onshape").isRevisionToken?.(WS), true);
  assert.equal(sourceById("onshape").isRevisionToken?.("not-a-microversion"), false);
  assert.equal(sourceById("makerworld").isRevisionToken, undefined);
});

test("the unsupported-URL hint names every source with an example", () => {
  const sentence = supportedSourcesSentence();
  for (const source of SOURCES) {
    assert.ok(sentence.includes(source.label), source.id);
    assert.ok(sentence.includes(source.exampleUrl), source.id);
  }
});
