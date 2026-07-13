import type { BomItemInput } from "@/lib/bom";

export type RemoteAsset = {
  url: string;
  filename: string;
  kind: "model" | "image" | "pdf";
  // Extra request headers for sources that gate downloads behind auth
  // (Onshape API downloads need the user's Basic auth header).
  headers?: Record<string, string>;
  // Onshape element the asset was exported from; stored on the model file so
  // sync can replace exactly these files.
  onshapeElementId?: string;
  // MakerWorld raw-model downloads: the URL may serve either a single .scad
  // file or a zip of several. Staging buffers the download and extracts the
  // .scad entries when it's a zip.
  extractScad?: boolean;
};

export type ImportedProject = {
  source: "makerworld" | "printables" | "onshape";
  sourceUrl: string;
  title: string;
  description: string;
  tags: string[];
  // Source platform category names, most specific first (MakerWorld's
  // `categories` list, Printables' `category.path`). Used only as an
  // indicator to suggest one of OUR existing categories
  // (src/lib/category-suggest.ts) — never to create new ones. Empty for
  // sources without a taxonomy (Onshape).
  categories: string[];
  assets: RemoteAsset[];
  // Bill of materials scraped from the source (MakerWorld). Empty for sources
  // that don't expose one.
  bom: BomItemInput[];
  warnings: string[];
  // Workspace microversion at export time (Onshape only, workspace pins only);
  // stored on the model so sync can tell whether the document changed.
  onshapeMicroversion?: string | null;
};

export class ImportError extends Error {}

export const IMPORT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
