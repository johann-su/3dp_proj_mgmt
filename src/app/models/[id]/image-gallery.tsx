"use client";

import { useState } from "react";
import { Box } from "lucide-react";
import { cn } from "@/lib/utils";

type GalleryImage = { id: string; filename: string };

export function ImageGallery({
  images,
  title,
}: {
  images: GalleryImage[];
  title: string;
}) {
  const [selected, setSelected] = useState(0);

  if (images.length === 0) {
    return (
      <div className="aspect-[4/3] rounded-lg bg-muted flex items-center justify-center">
        <Box className="size-16 text-muted-foreground/40" />
      </div>
    );
  }

  const current = images[Math.min(selected, images.length - 1)];

  return (
    <div className="grid gap-2">
      <div className="aspect-[4/3] rounded-lg bg-muted overflow-hidden flex items-center justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/files/${current.id}`}
          alt={title}
          className="w-full h-full object-contain"
        />
      </div>
      {images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto">
          {images.map((image, i) => (
            <button
              key={image.id}
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
                src={`/api/files/${image.id}`}
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
