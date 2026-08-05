"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { posterSrc } from "@/lib/video";

// Cover image for cards/grids. Animated covers (GIF / animated WebP / APNG,
// flagged server-side on the file — see @/lib/image-animated) are frozen to
// their first frame so browse views stay calm, then play on hover of the
// enclosing `.group` card, MakerWorld-style. A video cover behaves the same
// way for the same reason (see VideoCover). Static images render straight
// through next/image. The model detail gallery renders animated covers through
// next/image too, which passes them un-optimized and lets them play.
export function CoverImage({
  src,
  alt,
  sizes,
  className,
  animated,
  video,
}: {
  src: string;
  alt: string;
  sizes: string;
  className?: string;
  animated?: boolean;
  // The cover is an uploaded video file rather than an image.
  video?: boolean;
}) {
  if (video) {
    return <VideoCover src={src} alt={alt} className={className} />;
  }
  if (animated) {
    return <AnimatedCover src={src} alt={alt} className={className} />;
  }
  return (
    <Image src={src} alt={alt} fill sizes={sizes} className={className} />
  );
}

// A video cover: a still frame until the card is hovered, then it plays —
// muted and looping, the same "calm until you point at it" rule as an
// animated GIF cover. One <video> rather than a poster/live pair (what
// AnimatedCover does): a video element already holds its own paused frame, so
// swapping elements would only re-fetch the same bytes.
//
// The still comes from the file itself via posterSrc's media fragment; no
// poster image is generated server-side. `preload="metadata"` keeps a grid of
// cards from pulling whole videos — the rest streams in on hover.
function VideoCover({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  // Bound to the enclosing `.group` card, not to the video box, so the whole
  // card is the hover target — the same area `group-hover:` gives an animated
  // GIF cover. play/pause can't be expressed in CSS, hence the listeners.
  useEffect(() => {
    const el = ref.current;
    const card = el?.closest(".group") ?? el;
    if (!el || !card) return;

    const play = () => {
      // Autoplay policy permits this only because the element is muted; a
      // rejected promise (an autoplay-blocking setting, reduced motion) just
      // leaves the still frame up, which is the right fallback.
      void el.play().catch(() => {});
    };
    const pause = () => {
      el.pause();
      // Back to the frame the card shows at rest, so the next hover replays
      // from the top instead of resuming mid-clip.
      el.currentTime = 0;
    };

    // Pointer events rather than mouse ones: a touch device reports no hover,
    // so playback simply never starts there instead of latching on first tap.
    card.addEventListener("pointerenter", play);
    card.addEventListener("pointerleave", pause);
    return () => {
      card.removeEventListener("pointerenter", play);
      card.removeEventListener("pointerleave", pause);
    };
  }, []);

  return (
    <video
      ref={ref}
      src={posterSrc(src)}
      muted
      loop
      playsInline
      preload="metadata"
      aria-label={alt}
      className={cn("absolute inset-0 h-full w-full bg-black", className)}
    />
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
