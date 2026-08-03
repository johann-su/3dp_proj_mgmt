import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalYouTubeUrl,
  orderGalleryItems,
  parseYouTubeUrl,
  sanitizeModelVideos,
  youTubeEmbedUrl,
  youTubeThumbnailUrl,
} from "@/lib/video";

// Every form people actually paste has to land on the same video — the pasted
// string is never what gets embedded, only the id it yields.
test("parseYouTubeUrl accepts watch, youtu.be, shorts, embed and live links", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL123",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
    "  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ",
  ]) {
    assert.equal(parseYouTubeUrl(url)?.id, "dQw4w9WgXcQ", url);
  }
});

// Host matching is by equality after stripping "www." — a suffix check would
// hand a look-alike domain an iframe on the model page.
test("parseYouTubeUrl rejects look-alike hosts and non-http schemes", () => {
  for (const url of [
    "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
    "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
    "https://vimeo.com/watch?v=dQw4w9WgXcQ",
    "javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ",
    "not a url",
  ]) {
    assert.equal(parseYouTubeUrl(url), null, url);
  }
});

// The id is opaque but fixed-width; anything else is a link to a channel,
// playlist or search page, not a video we can embed.
test("parseYouTubeUrl rejects ids that aren't 11 url-safe characters", () => {
  assert.equal(parseYouTubeUrl("https://www.youtube.com/watch?v=short"), null);
  assert.equal(parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQextra"), null);
  assert.equal(parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXc/"), null);
  assert.equal(parseYouTubeUrl("https://www.youtube.com/@somechannel"), null);
  assert.equal(parseYouTubeUrl("https://www.youtube.com/playlist?list=PL123"), null);
});

// "Copy video URL at current time" produces t=90 / t=1m30s; the embed player
// wants plain seconds in `start`.
test("parseYouTubeUrl reads start offsets in seconds and h/m/s form", () => {
  assert.equal(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=90")?.start, 90);
  assert.equal(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=90s")?.start, 90);
  assert.equal(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=1h2m3s")?.start, 3723);
  assert.equal(parseYouTubeUrl("https://www.youtube.com/embed/dQw4w9WgXcQ?start=42")?.start, 42);
  // No offset, and offsets we can't make sense of, both mean "from the start".
  assert.equal(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ")?.start, null);
  assert.equal(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=soon")?.start, null);
});

test("canonicalYouTubeUrl normalizes every accepted form to one watch URL", () => {
  const shorts = parseYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")!;
  assert.equal(canonicalYouTubeUrl(shorts), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  const timed = parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=1m")!;
  assert.equal(canonicalYouTubeUrl(timed), "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=60");
});

// YouTube's own share embed, plus only the params we have a reason to add.
test("youTubeEmbedUrl builds the standard embed with start and autoplay", () => {
  const video = { id: "dQw4w9WgXcQ", start: 90 };
  assert.equal(
    youTubeEmbedUrl(video),
    "https://www.youtube.com/embed/dQw4w9WgXcQ?start=90",
  );
  assert.match(youTubeEmbedUrl(video, { autoplay: true }), /[?&]autoplay=1/);
  // No offset → a bare embed URL, no trailing "?".
  assert.equal(
    youTubeEmbedUrl({ id: "dQw4w9WgXcQ", start: null }),
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
  );
});

// hqdefault, not maxresdefault: the latter 404s for videos never uploaded in
// HD, which would leave a broken tile in the carousel.
test("youTubeThumbnailUrl picks a size that always exists", () => {
  const video = { id: "dQw4w9WgXcQ", start: null };
  assert.equal(youTubeThumbnailUrl(video), "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg");
  assert.equal(
    youTubeThumbnailUrl(video, "lg"),
    "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
  );
});

test("sanitizeModelVideos canonicalizes, drops blanks and dedupes by video", () => {
  const result = sanitizeModelVideos([
    { url: "https://youtu.be/dQw4w9WgXcQ", position: 2 },
    { url: "   ", position: 3 },
    // Same video, different form and offset — one carousel entry, not two.
    { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30", position: 4 },
    { url: "https://www.youtube.com/shorts/aBcDeFgHiJk", position: 0 },
  ]);
  assert.deepEqual(result, {
    videos: [
      { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", position: 2 },
      { url: "https://www.youtube.com/watch?v=aBcDeFgHiJk", position: 0 },
    ],
  });
});

// A save that carries something unembeddable is rejected rather than silently
// dropped — otherwise a link would vanish with no explanation.
test("sanitizeModelVideos errors on a non-YouTube link and past the cap", () => {
  assert.ok("error" in sanitizeModelVideos([{ url: "https://vimeo.com/12345", position: 0 }]));
  const many = Array.from({ length: 11 }, (_, i) => ({
    url: `https://www.youtube.com/watch?v=${String(i).padStart(11, "a")}`,
    position: i,
  }));
  assert.ok("error" in sanitizeModelVideos(many));
});

// The gallery is one sequence: a video dragged between two images has to come
// back out between those same two images.
test("orderGalleryItems places each video at the slot it claims", () => {
  const ordered = orderGalleryItems(
    ["a", "b", "c"],
    [{ position: 1, url: "v1" }, { position: 3, url: "v2" }],
  );
  assert.deepEqual(
    ordered.map((entry) => (entry.kind === "image" ? entry.item : entry.item.url)),
    ["a", "v1", "b", "v2", "c"],
  );
});

// Positions are written against the images the editor saw; a later sync or
// revert can remove images underneath them. Nothing may be dropped or
// duplicated when that happens — a claim that no longer fits just slides.
test("orderGalleryItems survives positions that overshoot or collide", () => {
  const overshoot = orderGalleryItems(["a"], [{ position: 99, url: "v1" }]);
  assert.deepEqual(
    overshoot.map((e) => (e.kind === "image" ? e.item : e.item.url)),
    ["a", "v1"],
  );

  const collision = orderGalleryItems(
    ["a", "b"],
    [{ position: 0, url: "v1" }, { position: 0, url: "v2" }],
  );
  assert.deepEqual(
    collision.map((e) => (e.kind === "image" ? e.item : e.item.url)),
    ["v1", "v2", "a", "b"],
  );
});
