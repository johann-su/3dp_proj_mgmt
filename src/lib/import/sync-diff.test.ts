import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeSyncPlan,
  planIsEmpty,
  type LocalSyncFile,
  type UpstreamFile,
} from "@/lib/import/sync-diff";

function local(overrides: Partial<LocalSyncFile> = {}): LocalSyncFile {
  return {
    id: "local-1",
    filename: "part.3mf",
    kind: "model",
    imported: true,
    generatedFromId: null,
    sourceFileId: "profile:1",
    sourceModifiedAt: "2025-01-01T00:00:00Z",
    createdAt: new Date("2025-01-02T00:00:00Z"),
    ...overrides,
  };
}

function upstream(overrides: Partial<UpstreamFile> = {}): UpstreamFile {
  return {
    sourceFileId: "profile:1",
    filename: "part.3mf",
    kind: "model",
    modifiedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

test("an unchanged token means no download and an empty plan", () => {
  const plan = computeSyncPlan([local()], [upstream()]);
  assert.equal(planIsEmpty(plan), true);
  assert.equal(plan.toStamp.length, 0);
});

test("a moved upstream token replaces the matched file", () => {
  const plan = computeSyncPlan(
    [local()],
    [upstream({ modifiedAt: "2025-06-01T00:00:00Z" })],
  );
  assert.equal(plan.toReplace.length, 1);
  assert.equal(plan.toReplace[0].local.id, "local-1");
});

test("matching is by id, so a local rename doesn't break the link", () => {
  // The user renamed the imported file — same upstream id, unchanged token.
  const plan = computeSyncPlan(
    [local({ filename: "my-better-name.3mf" })],
    [upstream()],
  );
  assert.equal(planIsEmpty(plan), true);
});

test("upstream files without a local counterpart are imported", () => {
  const plan = computeSyncPlan(
    [local()],
    [upstream(), upstream({ sourceFileId: "profile:2", filename: "new.3mf" })],
  );
  assert.deepEqual(
    plan.toImport.map((u) => u.sourceFileId),
    ["profile:2"],
  );
});

test("imported files gone upstream are removed; manual files and variants are invisible", () => {
  // Manual uploads (imported: false) and generated variants never sync, so
  // they must appear in no bucket — especially not toRemove.
  const plan = computeSyncPlan(
    [
      local(),
      local({ id: "manual", filename: "mine.3mf", imported: false, sourceFileId: null }),
      local({ id: "variant", generatedFromId: "src", sourceFileId: null }),
      local({ id: "gone", sourceFileId: "profile:9", filename: "old.3mf" }),
    ],
    [upstream()],
  );
  assert.deepEqual(
    plan.toRemove.map((f) => f.id),
    ["gone"],
  );
  assert.equal(plan.toImport.length, 0);
});

test("legacy imports without ids are adopted by filename and stamped", () => {
  // Files imported before source ids existed: same filename upstream, and the
  // upstream date predates the local import → our copy already is that
  // version, so only the bookkeeping columns get stamped.
  const plan = computeSyncPlan(
    [local({ sourceFileId: null, sourceModifiedAt: null })],
    [upstream({ modifiedAt: "2025-01-01T00:00:00Z" })],
  );
  assert.equal(planIsEmpty(plan), true);
  assert.deepEqual(plan.toStamp, [
    {
      localId: "local-1",
      sourceFileId: "profile:1",
      sourceModifiedAt: "2025-01-01T00:00:00Z",
    },
  ]);
});

test("an adopted file modified upstream after the import is replaced", () => {
  // Legacy import (no stored token): upstream edited the file after we
  // imported it, so the local copy is stale.
  const plan = computeSyncPlan(
    [local({ sourceFileId: null, sourceModifiedAt: null })],
    [upstream({ modifiedAt: "2025-03-01T00:00:00Z" })],
  );
  assert.equal(plan.toReplace.length, 1);
});

test("a missing upstream token counts as unchanged, never as changed", () => {
  // MakerWorld doc PDFs carry no timestamp — a match must not re-download on
  // every sync.
  const plan = computeSyncPlan(
    [
      local({
        sourceFileId: "doc:Guide.pdf",
        sourceModifiedAt: null,
        filename: "Guide.pdf",
        kind: "pdf",
      }),
    ],
    [
      upstream({
        sourceFileId: "doc:Guide.pdf",
        filename: "Guide.pdf",
        kind: "pdf",
        modifiedAt: null,
      }),
    ],
  );
  assert.equal(planIsEmpty(plan), true);
  assert.equal(plan.toStamp.length, 0);
});
