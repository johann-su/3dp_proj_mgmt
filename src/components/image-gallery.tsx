"use client";

import { useEffect, useRef, useState } from "react";
import { Box, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

type GalleryImage = { src: string };

export function ImageGallery({
  images,
  title,
}: {
  images: GalleryImage[];
  title: string;
}) {
  const [selected, setSelected] = useState(0);
  const thumbRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const index = Math.min(selected, images.length - 1);

  useEffect(() => {
    thumbRefs.current[index]?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [index]);

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
    <div className="grid gap-2">
      <div className="relative aspect-[4/3] rounded-lg bg-muted overflow-hidden flex items-center justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={current.src}
          alt={title}
          className="w-full h-full object-contain"
        />
        {images.length > 1 && (
          <>
            <button
              type="button"
              className="absolute left-2 top-1/2 -translate-y-1/2 flex size-8 items-center justify-center rounded-full bg-background/80 hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
              aria-label="Previous image"
              onClick={() => step(-1)}
            >
              <ChevronLeft className="size-5" />
            </button>
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 flex size-8 items-center justify-center rounded-full bg-background/80 hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
              aria-label="Next image"
              onClick={() => step(1)}
            >
              <ChevronRight className="size-5" />
            </button>
            <span className="absolute bottom-2 right-2 rounded-full bg-background/80 px-2 py-0.5 text-xs text-muted-foreground tabular-nums">
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
  );
}
