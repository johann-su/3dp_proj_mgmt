"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  Box,
  ChevronLeft,
  ChevronRight,
  Maximize,
  Minimize,
  Pause,
  Play,
  Rotate3d,
  Volume1,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatClock } from "@/lib/format";
import { ModelViewer, type ViewerFile } from "@/components/model-viewer";
import {
  orderGalleryItems,
  parseYouTubeUrl,
  posterSrc,
  youTubeEmbedUrl,
  youTubeThumbnailUrl,
  type ModelVideo,
  type YouTubeVideo,
} from "@/lib/video";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// One stored gallery file: a photo or an uploaded video, already signed
// (fileSrc) by the server. Both arrive in one list because they share the
// model's `position` sequence.
export type GalleryMedia = { src: string; kind: "image" | "video" };

// One carousel slide. All three sorts share a single index, so the arrows,
// the counter and the thumbnail strip don't have to know the difference.
type GalleryItem =
  | { kind: "image"; key: string; src: string }
  | { kind: "video"; key: string; src: string }
  | { kind: "youtube"; key: string; video: YouTubeVideo };

// An uploaded video slide. The controls are ours rather than the browser's:
// Chrome draws the played portion of its own timeline in a fixed UA blue that
// no CSS can reach (accent-color doesn't apply to media controls), so a
// theme-coloured progress bar means owning the transport. Everything visual
// here is a theme variable, so switching themes recolours the player.
//
// Not autoplayed — the carousel is also reachable by arrowing through, and a
// slide that starts talking on arrival is worse than one click. `preload`
// stays at metadata so opening a model page doesn't pull the whole file.
function VideoFileSlide({ src, title }: { src: string; title: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  // The frame, not the <video>, is what goes full screen: only the fullscreen
  // element and its descendants are painted, so fullscreening the video alone
  // would leave our control bar (its sibling) behind on a hidden page — and
  // since the video carries no native `controls`, that means no controls at all.
  const frameRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  // The chosen level, kept across a mute/unmute round-trip so unmuting comes
  // back at the volume it left rather than jumping to full.
  const [volume, setVolume] = useState(1);
  const [current, setCurrent] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  // 0 until metadata arrives; the scrubber stays disabled until then so it
  // can't seek against a duration we don't know yet.
  const [duration, setDuration] = useState(0);

  const toggle = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  }, []);

  // Esc and the browser's own full-screen affordances exit without going
  // through our button, so the icon tracks the document rather than a guess.
  useEffect(() => {
    const onChange = () =>
      setFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    if (frameRef.current?.requestFullscreen) {
      void frameRef.current.requestFullscreen().catch(() => {});
      return;
    }
    // iOS Safari has no element full screen — only the video's own native
    // one, which brings iOS's player controls with it. Better than a button
    // that does nothing.
    (
      ref.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
    )?.webkitEnterFullscreen?.();
  }

  function seek(seconds: number) {
    const el = ref.current;
    if (!el) return;
    el.currentTime = seconds;
    setCurrent(seconds);
  }

  const played = duration > 0 ? (current / duration) * 100 : 0;

  // What is actually coming out of the speakers, which is what both the slider
  // and the icon show: muted reads as 0 regardless of the level behind it.
  const level = muted ? 0 : volume;

  // Dragging the slider is also the other way to (un)mute: to zero is a mute,
  // off zero unmutes at the level dropped on.
  function setLevel(next: number) {
    setVolume(next);
    setMuted(next === 0);
  }

  function toggleMute() {
    if (!muted) {
      setMuted(true);
      return;
    }
    // Unmuting when the level behind the mute is itself zero (the slider was
    // dragged all the way down) has to land somewhere audible, or the button
    // would look broken: it would clear `muted` and still play nothing.
    if (volume === 0) setVolume(1);
    setMuted(false);
  }

  // `volume` is a property, not an attribute, so React can't set it from JSX
  // the way it does `muted`.
  useEffect(() => {
    const el = ref.current;
    if (el) el.volume = volume;
  }, [volume]);

  return (
    <div ref={frameRef} className="absolute inset-0 size-full bg-black">
      <video
        ref={ref}
        src={src}
        title={title}
        playsInline
        preload="metadata"
        muted={muted}
        className="size-full object-contain"
        // Clicking the picture is the other half of play/pause, the one
        // habit every player shares.
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        // A finished video shows its play button again rather than a frozen
        // last frame with no way back.
        onEnded={() => setPlaying(false)}
      />
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/80 to-transparent px-2 py-1.5">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Pause" : "Play"}
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-white/90 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
        >
          {playing ? (
            <Pause className="size-4 fill-current" />
          ) : (
            <Play className="size-4 fill-current" />
          )}
        </button>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step="any"
          value={current}
          disabled={duration === 0}
          aria-label="Seek"
          onChange={(e) => seek(Number(e.target.value))}
          // --played drives the fill; see .media-scrubber in globals.css.
          style={{ "--played": `${played}%` } as React.CSSProperties}
          className="media-scrubber min-w-0 flex-1"
        />
        <span className="shrink-0 text-[11px] tabular-nums text-white/80">
          {formatClock(current)} / {formatClock(duration)}
        </span>
        <div className="group/volume relative shrink-0">
          <button
            type="button"
            onClick={toggleMute}
            aria-label={muted ? "Unmute" : "Mute"}
            className="flex size-7 items-center justify-center rounded-full text-white/90 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          >
            {level === 0 ? (
              <VolumeX className="size-4" />
            ) : level < 0.5 ? (
              <Volume1 className="size-4" />
            ) : (
              <Volume2 className="size-4" />
            )}
          </button>
          {/* Revealed by hovering the icon — clicking it still just toggles
              mute. Hidden with opacity rather than `hidden`, so the slider
              stays in the tab order: display:none would take it out, and then
              focus-within could never bring it back. The wrapper's padding is
              the bridge between button and pill, so the pointer doesn't cross
              a dead gap on the way up and dismiss it. */}
          {/* z-20 clears the slide counter, which sits at z-auto but later in
              the DOM and would otherwise paint over the popup. */}
          <div className="pointer-events-none absolute bottom-full left-1/2 z-20 -translate-x-1/2 pb-2 opacity-0 transition-opacity group-hover/volume:pointer-events-auto group-hover/volume:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
            <div className="media-volume-box flex justify-center rounded-full px-2 py-2.5 shadow-lg">
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={level}
                aria-label="Volume"
                onChange={(e) => setLevel(Number(e.target.value))}
                style={{ "--played": `${level * 100}%` } as React.CSSProperties}
                className="media-scrubber media-scrubber-vertical"
              />
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label={fullscreen ? "Exit full screen" : "Full screen"}
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-white/90 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
        >
          {fullscreen ? (
            <Minimize className="size-4" />
          ) : (
            <Maximize className="size-4" />
          )}
        </button>
      </div>
    </div>
  );
}

// A YouTube slide: the video's poster frame with a play button, swapped for
// YouTube's own embed on click. Mounting the player only when asked keeps the
// page from pulling ~1 MB of YouTube JS per attached video on every load.
function YouTubeSlide({ video, title }: { video: YouTubeVideo; title: string }) {
  const [playing, setPlaying] = useState(false);

  if (playing) {
    return (
      <iframe
        // autoplay because mounting the frame *is* the play click.
        src={youTubeEmbedUrl(video, { autoplay: true })}
        title="YouTube video player"
        className="absolute inset-0 size-full border-0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
      />
    );
  }

  return (
    <button
      type="button"
      className="group/video absolute inset-0 size-full bg-black"
      aria-label={`Play video for ${title}`}
      onClick={() => setPlaying(true)}
    >
      {/* Remote host — next/image would need its own allowlist to add
          nothing at this size. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={youTubeThumbnailUrl(video, "lg")}
        alt=""
        className="size-full object-contain"
      />
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex h-12 w-[68px] items-center justify-center rounded-xl bg-red-600/90 transition-colors group-hover/video:bg-red-600">
          <Play className="size-7 fill-current text-white" />
        </span>
      </span>
    </button>
  );
}

export function ImageGallery({
  media,
  videos,
  title,
  badge,
  modelFiles,
}: {
  // Stored photos and videos, in gallery order.
  media: GalleryMedia[];
  // YouTube links with their slots in the combined order (see
  // orderGalleryItems). Anything that doesn't parse is dropped — the embed is
  // always rebuilt from the parsed id, never from the stored string.
  videos?: ModelVideo[];
  title: string;
  badge?: React.ReactNode;
  // Previewable .3mf files to offer as an interactive 3D view (issue #35).
  // When any are present, a Photos/3D toggle appears over the main frame.
  modelFiles?: ViewerFile[];
}) {
  const hasModel = !!modelFiles && modelFiles.length > 0;
  const [selected, setSelected] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const thumbRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // orderGalleryItems weaves the linked videos into the stored files; its own
  // "image"/"video" discriminator means "the file list" vs "the linked list",
  // so a stored file still has to be split by its own kind here.
  const items: GalleryItem[] = orderGalleryItems(
    media,
    (videos ?? []).flatMap((entry) => {
      const video = parseYouTubeUrl(entry.url);
      return video ? [{ ...entry, video }] : [];
    }),
  ).map((entry) =>
    entry.kind === "image"
      ? {
          kind: entry.item.kind,
          key: entry.item.src,
          src: entry.item.src,
        }
      : { kind: "youtube", key: entry.item.video.id, video: entry.item.video },
  );

  // 3D view is offered only when a .3mf is available; default to it when there
  // is nothing else to show. A viewer error flips this off so we fall back to
  // the slides (or the empty-state placeholder).
  const [show3d, setShow3d] = useState(hasModel && items.length === 0);

  const index = Math.min(selected, items.length - 1);

  useEffect(() => {
    thumbRefs.current[index]?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [index]);

  const closeLightbox = useCallback(() => setLightboxOpen(false), []);

  useEffect(() => {
    if (!lightboxOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeLightbox();
      if (e.key === "ArrowLeft") setSelected((i) => (i - 1 + items.length) % items.length);
      if (e.key === "ArrowRight") setSelected((i) => (i + 1) % items.length);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxOpen, items.length, closeLightbox]);

  // No slides: show the 3D viewer if we have a .3mf, otherwise the
  // placeholder box.
  if (items.length === 0) {
    return (
      <div className="relative aspect-[4/3] rounded-lg bg-muted overflow-hidden flex items-center justify-center">
        {show3d && hasModel ? (
          <ModelViewer files={modelFiles} onError={() => setShow3d(false)} />
        ) : (
          <Box className="size-16 text-muted-foreground/40" />
        )}
      </div>
    );
  }

  const current = items[index];

  const ModeToggle = hasModel && (
    <div className="absolute left-1/2 top-2 z-10 flex -translate-x-1/2 gap-0.5 rounded-full bg-background/80 p-0.5 shadow-sm backdrop-blur">
      <button
        type="button"
        onClick={() => setShow3d(false)}
        className={cn(
          "rounded-full px-3 py-1 text-xs font-medium transition-colors",
          show3d ? "text-muted-foreground hover:text-foreground" : "bg-primary text-primary-foreground",
        )}
      >
        Photos
      </button>
      <button
        type="button"
        onClick={() => setShow3d(true)}
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition-colors",
          show3d ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Rotate3d className="size-3.5" />
        3D
      </button>
    </div>
  );

  function step(direction: -1 | 1) {
    setSelected((index + direction + items.length) % items.length);
  }

  return (
    <>
      {lightboxOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
          onClick={closeLightbox}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                aria-label="Close"
                onClick={closeLightbox}
              >
                <X className="size-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Close</TooltipContent>
          </Tooltip>
          {items.length > 1 && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="absolute left-4 top-1/2 -translate-y-1/2 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                    aria-label="Previous"
                    onClick={(e) => { e.stopPropagation(); setSelected((index - 1 + items.length) % items.length); }}
                  >
                    <ChevronLeft className="size-6" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Previous</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="absolute right-4 top-1/2 -translate-y-1/2 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                    aria-label="Next"
                    onClick={(e) => { e.stopPropagation(); setSelected((index + 1) % items.length); }}
                  >
                    <ChevronRight className="size-6" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Next</TooltipContent>
              </Tooltip>
              <span className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-sm text-white tabular-nums">
                {index + 1} / {items.length}
              </span>
            </>
          )}
          {current.kind !== "image" ? (
            // Arrowing through the lightbox can land on either sort of video;
            // give both the same frame, sized to the viewport.
            <div
              className="relative aspect-video w-[80vw] max-h-[80vh] max-w-[calc(80vh*16/9)] overflow-hidden bg-black"
              onClick={(e) => e.stopPropagation()}
            >
              {current.kind === "youtube" ? (
                <YouTubeSlide video={current.video} title={title} />
              ) : (
                <VideoFileSlide src={current.src} title={title} />
              )}
            </div>
          ) : (
            <>
              {/* Lightbox is the "view full size" path: serve the untouched
                  original at full resolution/quality, not an optimized
                  derivative. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={current.src}
                alt={title}
                className="max-h-[80vh] max-w-[80vw]"
                onClick={(e) => e.stopPropagation()}
              />
            </>
          )}
        </div>
      )}

    <div className="grid gap-2">
      <div className="relative aspect-[4/3] rounded-lg bg-muted overflow-hidden flex items-center justify-center group">
        {show3d && hasModel ? (
          <ModelViewer files={modelFiles} onError={() => setShow3d(false)} />
        ) : current.kind === "youtube" ? (
          // Keyed by video so switching slides resets to the poster instead of
          // carrying the previous video's player over.
          <YouTubeSlide key={current.key} video={current.video} title={title} />
        ) : current.kind === "video" ? (
          // Keyed likewise, so arrowing to another video starts a fresh
          // element rather than reusing one that is mid-playback.
          <VideoFileSlide key={current.key} src={current.src} title={title} />
        ) : (
          <button
            type="button"
            className="absolute inset-0 w-full h-full"
            aria-label="View full size"
            onClick={() => setLightboxOpen(true)}
          >
            <Image
              src={current.src}
              alt={title}
              fill
              sizes="(max-width: 1024px) 100vw, 60vw"
              quality={90}
              className="object-contain"
            />
            <span className="absolute right-2 top-2 flex size-8 items-center justify-center rounded-full bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity">
              <ZoomIn className="size-4" />
            </span>
          </button>
        )}
        {ModeToggle}
        {badge && (
          <div className="absolute left-2 top-2 pointer-events-none">{badge}</div>
        )}
        {!show3d && items.length > 1 && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="absolute left-2 top-1/2 -translate-y-1/2 flex size-8 items-center justify-center rounded-full bg-background/80 hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50 outline-none z-10"
                  aria-label="Previous"
                  onClick={(e) => { e.stopPropagation(); step(-1); }}
                >
                  <ChevronLeft className="size-5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Previous</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 flex size-8 items-center justify-center rounded-full bg-background/80 hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50 outline-none z-10"
                  aria-label="Next"
                  onClick={(e) => { e.stopPropagation(); step(1); }}
                >
                  <ChevronRight className="size-5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Next</TooltipContent>
            </Tooltip>
            <span
              className={cn(
                "absolute right-2 rounded-full bg-background/80 px-2 py-0.5 text-xs text-muted-foreground tabular-nums pointer-events-none",
                // A video slide owns the bottom strip with its control bar —
                // sit above it rather than on top of the full-screen button.
                current.kind === "video" ? "bottom-11" : "bottom-2",
              )}
            >
              {index + 1} / {items.length}
            </span>
          </>
        )}
      </div>
      {items.length > 1 && (
        <div className="flex gap-2 overflow-x-auto">
          {items.map((item, i) => (
            <button
              key={item.key}
              ref={(el) => {
                thumbRefs.current[i] = el;
              }}
              type="button"
              onClick={() => {
                setSelected(i);
                setShow3d(false);
              }}
              className={cn(
                "relative size-16 rounded-md overflow-hidden bg-muted border-2 shrink-0",
                i === selected && !show3d ? "border-primary" : "border-transparent",
              )}
              aria-label={
                item.kind === "image" ? `Show image ${i + 1}` : `Show video ${i + 1}`
              }
            >
              {item.kind === "youtube" ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={youTubeThumbnailUrl(item.video)}
                    alt=""
                    className="size-full object-cover"
                  />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/20">
                    <span className="flex h-4 w-6 items-center justify-center rounded bg-red-600">
                      <Play className="size-2.5 fill-current text-white" />
                    </span>
                  </span>
                </>
              ) : item.kind === "video" ? (
                <>
                  {/* A still from the file itself — no separate poster image
                      is stored, so the tile seeks one frame in and paints
                      that (see posterSrc). */}
                  <video
                    src={posterSrc(item.src)}
                    muted
                    playsInline
                    preload="metadata"
                    className="size-full bg-black object-cover"
                  />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/20">
                    <span className="flex h-4 w-6 items-center justify-center rounded bg-black/70">
                      <Play className="size-2.5 fill-current text-white" />
                    </span>
                  </span>
                </>
              ) : (
                <Image
                  src={item.src}
                  alt=""
                  fill
                  sizes="64px"
                  className="object-cover"
                />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
    </>
  );
}
