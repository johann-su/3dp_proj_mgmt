"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Box, ChevronLeft, ChevronRight, Play, Rotate3d, X, ZoomIn } from "lucide-react";
import { cn } from "@/lib/utils";
import { ModelViewer, type ViewerFile } from "@/components/model-viewer";
import {
  orderGalleryItems,
  parseYouTubeUrl,
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

type GalleryImage = { src: string };

// One carousel slide. Images and videos share a single index, so the arrows,
// the counter and the thumbnail strip don't have to know the difference.
type GalleryItem =
  | { kind: "image"; key: string; src: string }
  | { kind: "video"; key: string; video: YouTubeVideo };

// A YouTube slide: the video's poster frame with a play button, swapped for
// YouTube's own embed on click. Mounting the player only when asked keeps the
// page from pulling ~1 MB of YouTube JS per attached video on every load.
function VideoSlide({ video, title }: { video: YouTubeVideo; title: string }) {
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
  images,
  videos,
  title,
  badge,
  modelFiles,
}: {
  images: GalleryImage[];
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

  const items: GalleryItem[] = orderGalleryItems(
    images,
    (videos ?? []).flatMap((entry) => {
      const video = parseYouTubeUrl(entry.url);
      return video ? [{ ...entry, video }] : [];
    }),
  ).map((entry) =>
    entry.kind === "image"
      ? { kind: "image", key: entry.item.src, src: entry.item.src }
      : { kind: "video", key: entry.item.video.id, video: entry.item.video },
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
          {current.kind === "video" ? (
            // Arrowing through the lightbox can land on a video; give it the
            // same poster-then-player frame, sized to the viewport.
            <div
              className="relative aspect-video w-[80vw] max-h-[80vh] max-w-[calc(80vh*16/9)] overflow-hidden bg-black"
              onClick={(e) => e.stopPropagation()}
            >
              <VideoSlide video={current.video} title={title} />
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
        ) : current.kind === "video" ? (
          // Keyed by video so switching slides resets to the poster instead of
          // carrying the previous video's player over.
          <VideoSlide key={current.key} video={current.video} title={title} />
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
            <span className="absolute bottom-2 right-2 rounded-full bg-background/80 px-2 py-0.5 text-xs text-muted-foreground tabular-nums pointer-events-none">
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
                item.kind === "video" ? `Show video ${i + 1}` : `Show image ${i + 1}`
              }
            >
              {item.kind === "video" ? (
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
