import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_COLLECTION_DESIGNS,
  fetchMakerworldCollection,
  listMakerworldCollectionDesigns,
  parseMakerworldCollectionUrl,
} from "@/lib/import/makerworld-collection";
import { ImportError } from "@/lib/import/types";

test("parseMakerworldCollectionUrl returns the collection id for makerworld hosts", () => {
  // slugged and locale-prefixed URLs are what the site links to
  assert.equal(
    parseMakerworldCollectionUrl(
      new URL("https://makerworld.com/en/collections/10557122-drones-robots"),
    ),
    "10557122",
  );
  assert.equal(
    parseMakerworldCollectionUrl(new URL("https://www.makerworld.com/collections/504356")),
    "504356",
  );
});

test("parseMakerworldCollectionUrl rejects non-collection and look-alike URLs", () => {
  // a model URL must not start a collection import
  assert.equal(
    parseMakerworldCollectionUrl(new URL("https://makerworld.com/en/models/12345")),
    null,
  );
  assert.equal(
    parseMakerworldCollectionUrl(new URL("https://notmakerworld.com/collections/1")),
    null,
  );
  // the collections index page has no id
  assert.equal(
    parseMakerworldCollectionUrl(new URL("https://makerworld.com/en/collections")),
    null,
  );
});

function stubFetch(t: { mock: { method: typeof import("node:test").mock.method } },
  handler: (url: string) => { status: number; body: unknown }) {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const { status, body } = handler(String(input));
    return new Response(JSON.stringify(body), { status });
  });
}

test("listMakerworldCollectionDesigns pages with offset until total is reached", async (t) => {
  const requested: string[] = [];
  stubFetch(t, (url) => {
    requested.push(url);
    const offset = Number(new URL(url).searchParams.get("offset"));
    // 52 designs → one full page of 50, then a page of 2
    const hits = Array.from({ length: Math.min(50, 52 - offset) }, (_, i) => ({
      id: offset + i + 1,
      title: `Design ${offset + i + 1}`,
    }));
    return { status: 200, body: { hits, total: 52 } };
  });

  const designs = await listMakerworldCollectionDesigns("777");
  assert.equal(designs.length, 52);
  assert.deepEqual(designs[0], { id: 1, title: "Design 1" });
  assert.deepEqual(designs[51], { id: 52, title: "Design 52" });
  assert.equal(requested.length, 2);
  assert.match(requested[0], /favorites\/777\/designs/);
});

test("listMakerworldCollectionDesigns caps runaway collections", async (t) => {
  // API that never runs out of hits (total missing) must still terminate
  stubFetch(t, (url) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    const hits = Array.from({ length: 50 }, (_, i) => ({ id: offset + i + 1 }));
    return { status: 200, body: { hits } };
  });

  const designs = await listMakerworldCollectionDesigns("777");
  assert.equal(designs.length, MAX_COLLECTION_DESIGNS);
});

test("fetchMakerworldCollection rejects the empty envelope for unknown ids", async (t) => {
  // the API answers 200 with id:0 instead of a 404 for ids that don't exist
  stubFetch(t, () => ({ status: 200, body: { id: 0, title: "" } }));
  await assert.rejects(fetchMakerworldCollection("999"), ImportError);
});

test("fetchMakerworldCollection returns title, description and design count", async (t) => {
  stubFetch(t, () => ({
    status: 200,
    body: { id: 10557122, title: " drones/robots ", description: "", designCnt: 87 },
  }));
  const collection = await fetchMakerworldCollection("10557122");
  assert.deepEqual(collection, {
    id: 10557122,
    title: "drones/robots",
    description: "",
    designCnt: 87,
  });
});
