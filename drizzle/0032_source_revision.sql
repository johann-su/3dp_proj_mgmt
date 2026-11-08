-- Generalizes the Onshape-only workspace microversion into an opaque per-model upstream revision token, so the column means the same thing for any source that versions a whole design (src/lib/sources/registry.ts). Values carry over unchanged; only Onshape models ever had one.
ALTER TABLE "models" RENAME COLUMN "onshape_microversion" TO "source_revision";
