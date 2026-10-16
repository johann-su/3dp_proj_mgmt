import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readBlobBytes, type BlobStore } from "@/lib/blob-store";
import { FsBlobStore } from "@/lib/blob-store-fs";

// Each test gets its own scratch root, removed afterwards. Typed as the
// interface: these tests pin the BlobStore contract, not the class.
async function withStore(fn: (store: BlobStore, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "blob-store-"));
  try {
    await fn(new FsBlobStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(bytes(c));
      controller.close();
    },
  });
}

test("a buffer and a stream both round-trip under nested upload keys", async () => {
  await withStore(async (store) => {
    await store.put("uploads/a/part.3mf", bytes("buffered"), "model/3mf");
    await store.put("uploads/b/part.3mf", streamOf("str", "eam", "ed"), "model/3mf");
    assert.equal(text(await readBlobBytes(store, "uploads/a/part.3mf")), "buffered");
    assert.equal(text(await readBlobBytes(store, "uploads/b/part.3mf")), "streamed");
  });
});

// The file routes turn a missing object into a 404 rather than a 500.
test("reading a key that was never stored yields null", async () => {
  await withStore(async (store) => {
    assert.equal(await store.get("uploads/nope/x.stl"), null);
  });
});

// Video seeking and the 3MF ZIP-tail reader both depend on exact ranges; the
// reported length is what becomes the 206 response's Content-Length.
test("ranged reads are inclusive and report their own length", async () => {
  await withStore(async (store) => {
    await store.put("k/f", bytes("0123456789"), "application/octet-stream");
    const blob = await store.get("k/f", { start: 2, end: 5 });
    assert.equal(blob?.contentLength, 4);
    assert.equal(text(await readBlobBytes(store, "k/f", { start: 2, end: 5 })), "2345");
  });
});

// detectAnimated asks for the first 256 bytes of images that may be smaller.
test("a range past the end is clamped to the object", async () => {
  await withStore(async (store) => {
    await store.put("k/small", bytes("abc"), "image/png");
    const blob = await store.get("k/small", { start: 0, end: 255 });
    assert.equal(blob?.contentLength, 3);
    assert.equal(text(await readBlobBytes(store, "k/small", { start: 0, end: 255 })), "abc");
    assert.equal((await store.get("k/small", { start: 10, end: 20 }))?.contentLength, 0);
  });
});

// A failed upload must not leave a truncated file readable under the key, nor
// a stray temp file in the volume.
test("an upload whose stream errors leaves nothing behind", async () => {
  await withStore(async (store, root) => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes("partial"));
        controller.error(new Error("client went away"));
      },
    });
    await assert.rejects(store.put("uploads/c/x.stl", failing, "model/stl"));
    assert.equal(await store.get("uploads/c/x.stl"), null);
    assert.deepEqual(await readdir(path.join(root, "uploads/c")), []);
  });
});

// Deleting is idempotent (versioning may delete a key twice), and the
// per-upload directories it empties are pruned so the volume doesn't fill
// up with empty "uploads/<uuid>/" folders — but the root itself stays.
test("delete removes objects, tolerates missing keys and prunes empty dirs", async () => {
  await withStore(async (store, root) => {
    await store.put("uploads/a/one", bytes("1"), "text/plain");
    await store.put("uploads/b/two", bytes("2"), "text/plain");
    await store.delete(["uploads/a/one", "uploads/missing/x"]);
    assert.equal(await store.get("uploads/a/one"), null);
    assert.equal(text(await readBlobBytes(store, "uploads/b/two")), "2");
    assert.deepEqual(await readdir(path.join(root, "uploads")), ["b"]);
    await store.delete(["uploads/b/two"]);
    assert.deepEqual(await readdir(root), []);
  });
});

// Keys come back out of the DB and version snapshots; none may escape the root.
test("keys that could escape the storage root are rejected", async () => {
  await withStore(async (store) => {
    for (const key of ["../etc/passwd", "uploads/../../x", "/abs", "a//b", "a\\b", "a/./b", ""]) {
      await assert.rejects(store.get(key), `expected ${JSON.stringify(key)} to be rejected`);
    }
  });
});
