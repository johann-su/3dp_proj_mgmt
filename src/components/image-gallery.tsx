"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, ChevronLeft, ChevronRight, X, ZoomIn } from "lucide-react";
import { cn } from "@/lib/utils";

type GalleryImage = { src: string };

export function ImageGallery({
  images,
  title,
  badge,
}: {
  images: GalleryImage[];
  title: string;
  badge?: React.ReactNode;
}) {
  const [selected, setSelected] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const thumbRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const index = Math.min(selected, images.length - 1);

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
      if (e.key === "ArrowLeft") setSelected((i) => (i - 1 + images.length) % images.length);
      if (e.key === "ArrowRight") setSelected((i) => (i + 1) % images.length);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxOpen, images.length, closeLightbox]);

  if (images.length === 0) {
    return (
      <div className="aspect-[4/3] rounded-lg bg-muted flex items-center justify-center">
        <Box className="size-16 text-muted-foreground/40" />
      </div>
    );
  }

  const current = images[index];

  function step(direction: -1 | 1) {
    setSelected((index + direction + images.length) % images.length);
  }

  return (
    <>
      {lightboxOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
          onClick={closeLightbox}
        >
          <button
            type="button"
            className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
            aria-label="Close"
            onClick={closeLightbox}
          >
            <X className="size-5" />
          </button>
          {images.length > 1 && (
            <>
              <button
                type="button"
                className="absolute left-4 top-1/2 -translate-y-1/2 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                aria-label="Previous image"
                onClick={(e) => { e.stopPropagation(); setSelected((index - 1 + images.length) % images.length); }}
              >
                <ChevronLeft className="size-6" />
              </button>
              <button
                type="button"
                className="absolute right-4 top-1/2 -translate-y-1/2 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                aria-label="Next image"
                onClick={(e) => { e.stopPropagation(); setSelected((index + 1) % images.length); }}
              >
                <ChevronRight className="size-6" />
              </button>
              <span className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-sm text-white tabular-nums">
                {index + 1} / {images.length}
              </span>
            </>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={current.src}
            alt={title}
            className="max-h-[80vh] max-w-[80vw]"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

    <div className="grid gap-2">
      <div className="relative aspect-[4/3] rounded-lg bg-muted overflow-hidden flex items-center justify-center group">
        <button
          type="button"
          className="absolute inset-0 w-full h-full"
          aria-label="View full size"
          onClick={() => setLightboxOpen(true)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={current.src}
            alt={title}
            className="w-full h-full object-contain"
          />
          <span className="absolute right-2 top-2 flex size-8 items-center justify-center rounded-full bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity">
            <ZoomIn className="size-4" />
          </span>
        </button>
        {badge && (
          <div className="absolute left-2 top-2 pointer-events-none">{badge}</div>
        )}
        {images.length > 1 && (
          <>
            <button
              type="button"
              className="absolute left-2 top-1/2 -translate-y-1/2 flex size-8 items-center justify-center rounded-full bg-background/80 hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50 outline-none z-10"
              aria-label="Previous image"
              onClick={(e) => { e.stopPropagation(); step(-1); }}
            >
              <ChevronLeft className="size-5" />
            </button>
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 flex size-8 items-center justify-center rounded-full bg-background/80 hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50 outline-none z-10"
              aria-label="Next image"
              onClick={(e) => { e.stopPropagation(); step(1); }}
            >
              <ChevronRight className="size-5" />
            </button>
            <span className="absolute bottom-2 right-2 rounded-full bg-background/80 px-2 py-0.5 text-xs text-muted-foreground tabular-nums pointer-events-none">
              {index + 1} / {images.length}
            </span>
          </>
        )}
      </div>
      {images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto">
          {images.map((image, i) => (
            <button
              key={image.src}
              ref={(el) => {
                thumbRefs.current[i] = el;
              }}
              type="button"
              onClick={() => setSelected(i)}
              className={cn(
                "size-16 rounded-md overflow-hidden bg-muted border-2 shrink-0",
                i === selected ? "border-primary" : "border-transparent",
              )}
              aria-label={`Show image ${i + 1}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.src}
                alt=""
                className="w-full h-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </div>
    </>
  );
}
