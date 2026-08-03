// YouTube videos attached to a model's gallery. The whole feature is
// URL-shaped — nothing is downloaded or stored but the link — so every layer
// (save, render, archive import) goes through the parser here, and the iframe
// src is always *rebuilt* from the parsed video id rather than echoing back
// whatever string was stored. That is what keeps a hostile "URL" from ever
// reaching an iframe: a value that doesn't parse has no embed.
//
// Pure and DB-free so both the server actions and the client gallery can
// import it (see src/lib/video.test.ts).

// Bounded so the carousel stays navigable and the models row stays small.
export const MAX_MODEL_VIDEOS = 10;

// The opaque 11-character id YouTube gives every video.
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// Hosts that address a YouTube video, compared for *equality* after dropping a
// leading "www." — a suffix test would happily accept
// "youtube.com.evil.example".
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "youtu.be",
]);

// Path prefixes that carry the id in the next segment: /shorts/<id> (a Short),
// /embed/<id> (someone pasted the embed code's src), /live/<id> (a premiere or
// stream) and the legacy /v/<id>.
const ID_PATH_PREFIXES = new Set(["shorts", "embed", "live", "v"]);

export type YouTubeVideo = {
  id: string;
  // Start offset in whole seconds, or null for "from the beginning".
  start: number | null;
};

// One video as stored on the model (models.videos). `position` is the slot the
// video occupies in the *combined* gallery order — images and videos share one
// sequence, so a video dragged between two images keeps that place (see
// orderGalleryItems).
export type ModelVideo = {
  url: string;
  position: number;
};

// YouTube writes start offsets as "90", "90s" or "1h2m3s"; all three appear in
// links people copy out of the player ("Copy video URL at current time").
function parseStart(raw: string | null): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return seconds > 0 ? seconds : null;
  }
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw.toLowerCase());
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const seconds =
    Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return seconds > 0 ? seconds : null;
}

// The video a link points at, or null if it isn't a YouTube video link at all.
// Accepts the forms people actually paste: watch?v=, youtu.be/, /shorts/,
// /embed/, /live/ and /v/.
export function parseYouTubeUrl(raw: string): YouTubeVideo | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!YOUTUBE_HOSTS.has(host)) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const id =
    host === "youtu.be"
      ? segments[0]
      : segments[0] === "watch"
        ? (url.searchParams.get("v") ?? "")
        : ID_PATH_PREFIXES.has(segments[0] ?? "")
          ? segments[1]
          : undefined;
  if (!id || !VIDEO_ID_RE.test(id)) return null;

  return {
    id,
    start: parseStart(url.searchParams.get("t") ?? url.searchParams.get("start")),
  };
}

// The single form a video is stored in, whichever of the accepted forms was
// pasted. Storing the canonical watch URL (rather than the bare id) keeps the
// column readable and the value directly openable on youtube.com.
export function canonicalYouTubeUrl(video: YouTubeVideo): string {
  return `https://www.youtube.com/watch?v=${video.id}${
    video.start ? `&t=${video.start}` : ""
  }`;
}

// The iframe src — YouTube's own share embed (youtube.com/embed/<id>), with
// the two params we have a reason to add: the start offset a timestamped link
// carried, and autoplay when the viewer has just clicked play on the poster.
export function youTubeEmbedUrl(
  video: YouTubeVideo,
  opts: { autoplay?: boolean } = {},
): string {
  const params = new URLSearchParams();
  if (video.start) params.set("start", String(video.start));
  if (opts.autoplay) params.set("autoplay", "1");
  const query = params.toString();
  return `https://www.youtube.com/embed/${video.id}${query ? `?${query}` : ""}`;
}

// Poster frame, from YouTube's thumbnail host. "mq" (320×180) for the small
// tiles in the carousel strip and the edit form, "hq" (480×360) for the main
// frame — deliberately not maxresdefault, which 404s on videos never uploaded
// in HD. Both are plain <img> sources: they're remote, so next/image would
// need its own allowlist for no benefit at these sizes.
export function youTubeThumbnailUrl(
  video: YouTubeVideo,
  size: "sm" | "lg" = "sm",
): string {
  return `https://i.ytimg.com/vi/${video.id}/${size === "lg" ? "hq" : "mq"}default.jpg`;
}

// Validates and canonicalizes what a save was given. Returns the cleaned list
// or an error string, like sanitizeBomItems. Duplicates are dropped by video
// id (the same video twice in one carousel is a mistake, not an intent), and
// a start offset makes no difference to that. Positions are kept as given —
// orderGalleryItems is what makes sense of gaps, duplicates and overshoot, so
// nothing here has to know how many images the model has.
export function sanitizeModelVideos(
  videos: ModelVideo[],
): { videos: ModelVideo[] } | { error: string } {
  const cleaned: ModelVideo[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of videos.entries()) {
    const raw = typeof entry?.url === "string" ? entry.url : "";
    if (!raw.trim()) continue;
    const video = parseYouTubeUrl(raw);
    if (!video) return { error: `Not a YouTube video link: ${raw.trim().slice(0, 100)}` };
    if (seen.has(video.id)) continue;
    seen.add(video.id);
    cleaned.push({
      url: canonicalYouTubeUrl(video),
      // A missing or nonsense position falls back to "after everything placed
      // so far", which is where an appended video belongs.
      position:
        Number.isSafeInteger(entry.position) && entry.position >= 0
          ? entry.position
          : i,
    });
  }
  if (cleaned.length > MAX_MODEL_VIDEOS) {
    return { error: `A model can have at most ${MAX_MODEL_VIDEOS} videos` };
  }
  return { videos: cleaned };
}

// Weaves the videos into the image list to produce the gallery's single
// display order. Each video claims the slot its `position` names; images fill
// what's left, in their own order.
//
// Deliberately total: positions are written by the edit form against the state
// it saw, but images can also disappear underneath them (a sync, a revert, an
// edit from another session), so this has to do something sensible with a
// position that's out of range or claimed twice — it never drops or duplicates
// an item, it only slides the collision later. Generic over the image type so
// the model page, the version preview and the wizard preview can all use it.
export function orderGalleryItems<I, V extends { position: number }>(
  images: I[],
  videos: V[],
): ({ kind: "image"; item: I } | { kind: "video"; item: V })[] {
  const pending = [...videos].sort((a, b) => a.position - b.position);
  const queue = [...images];
  const ordered: ({ kind: "image"; item: I } | { kind: "video"; item: V })[] = [];
  const total = images.length + videos.length;
  for (let slot = 0; slot < total; slot++) {
    if (pending.length > 0 && (pending[0].position <= slot || queue.length === 0)) {
      ordered.push({ kind: "video", item: pending.shift()! });
    } else {
      ordered.push({ kind: "image", item: queue.shift()! });
    }
  }
  return ordered;
}
