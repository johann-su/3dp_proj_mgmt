"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";

// Cover image for cards/grids. Animated covers (GIF / animated WebP / APNG,
// flagged server-side on the file — see @/lib/image-animated) are frozen to
// their first frame so browse views stay calm, then play on hover of the
// enclosing `.group` card, MakerWorld-style. Static images render straight
// through next/image. The model detail gallery renders animated covers through
// next/image too, which passes them un-optimized and lets them play.
export function CoverImage({
  src,
  alt,
  sizes,
  className,
  animated,
}: {
  src: string;
  alt: string;
  sizes: string;
  className?: string;
  animated?: boolean;
}) {
  if (animated) {
    return <AnimatedCover src={src} alt={alt} className={className} />;
  }
  return (
    <Image src={src} alt={alt} fill sizes={sizes} className={className} />
  );
}

// Poster frame (drawn once onto a canvas: drawImage captures whatever frame is
// current at load — the first — so it never animates) with the live image
// cross-fading in on hover of the enclosing `.group` card. Same-origin
// (/api/files) so the canvas isn't tainted; we only draw, never read pixels.
// The canvas already fetches the image, so the <img> that plays on hover hits
// the browser cache rather than downloading it again.
function AnimatedCover({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const img = new window.Image();
    img.decoding = "async";
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")?.drawImage(img, 0, 0);
    };
    img.src = src;
    return () => {
      img.onload = null;
    };
  }, [src]);

  return (
    <>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={alt}
        className={cn(
          "absolute inset-0 h-full w-full group-hover:opacity-0",
          className,
          // Last so tailwind-merge keeps it over the card's transition-transform:
          // animates both the poster→live cross-fade and the hover scale.
          "transition-all duration-200",
        )}
      />
      {/* Live (animated) image, revealed on card hover. Intentionally a raw
          <img>: next/image would route this through the optimizer, and we want
          the untouched animated bytes. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        aria-hidden
        className={cn(
          "absolute inset-0 h-full w-full opacity-0 group-hover:opacity-100",
          className,
          "transition-all duration-200",
        )}
      />
    </>
  );
}
