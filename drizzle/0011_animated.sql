-- Animated-cover flag: browse cards freeze animated GIF/WebP/APNG covers to a
-- poster frame and play them on hover. Content type can't distinguish an
-- animated WebP/PNG from a static one, so this is detected from the header
-- bytes at insert time (see @/lib/image-animated).
ALTER TABLE "model_files" ADD COLUMN "animated" boolean DEFAULT false NOT NULL;
