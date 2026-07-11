"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Box, ChevronLeft, ChevronRight, Rotate3d, X, ZoomIn } from "lucide-react";
import { cn } from "@/lib/utils";
import { ModelViewer, type ViewerFile } from "@/components/model-viewer";

type GalleryImage = { src: string };

export function ImageGallery({
  images,
  title,
  badge,
  modelFiles,
}: {
  images: GalleryImage[];
  title: string;
  badge?: React.ReactNode;
  // Previewable .3mf files to offer as an interactive 3D view (issue #35).
  // When any are present, a Photos/3D toggle appears over the main frame.
  modelFiles?: ViewerFile[];
}) {
  const hasModel = !!modelFiles && modelFiles.length > 0;
  const [selected, setSelected] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // 3D view is offered only when a .3mf is available; default to it when there
  // are no thumbnail images to show. A viewer error flips this off so we fall
  // back to the images (or the empty-state placeholder).
  const [show3d, setShow3d] = useState(hasModel && images.length === 0);
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

  // No thumbnails: show the 3D viewer if we have a .3mf, otherwise the
  // placeholder box.
  if (images.length === 0) {
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

  const current = images[index];

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
          {/* Lightbox is the "view full size" path: serve the untouched
              original at full resolution/quality, not an optimized derivative. */}
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
        {show3d && hasModel ? (
          <ModelViewer files={modelFiles} onError={() => setShow3d(false)} />
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
        {!show3d && images.length > 1 && (
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
              onClick={() => {
                setSelected(i);
                setShow3d(false);
              }}
              className={cn(
                "relative size-16 rounded-md overflow-hidden bg-muted border-2 shrink-0",
                i === selected && !show3d ? "border-primary" : "border-transparent",
              )}
              aria-label={`Show image ${i + 1}`}
            >
              <Image
                src={image.src}
                alt=""
                fill
                sizes="64px"
                className="object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </div>
    </>
  );
}
