// DB rows → the API's response shapes (src/lib/api/schemas.ts). Pure — rows in, plain objects out — so what the API exposes is unit-tested, and every field is projected by hand: spreading a row would publish whatever column is added to it next (S3 keys, content hashes, download counters).
//
// URLs are absolute and built by the caller's `url` (appUrl in the routes), never from the request, which behind a proxy is the internal bind address.

import type { collections, modelFiles } from "@/db/schema";
import type { BomItemInput } from "@/lib/bom";
import { isApproxEstimate, printerInfoPayload } from "@/lib/printer-info";
import { platformFromSourceUrl } from "@/lib/platform";
import type { ModelVideo } from "@/lib/video";
import type {
  ApiCollectionOut,
  ApiFileOut,
  ApiModelOut,
  ApiModelSummaryOut,
} from "./schemas";

export type UrlFor = (path: string) => string;

type FileRow = Pick<
  typeof modelFiles.$inferSelect,
  | "id"
  | "kind"
  | "filename"
  | "size"
  | "contentType"
  | "position"
  | "imported"
  | "generatedFromId"
  | "sliceStatus"
  | "sliceSource"
  | "sliceApprox"
  | "sliceError"
  | "sliceEngine"
  | "slicePrinter"
  | "printTimeSeconds"
  | "filamentGrams"
  | "printerInfo"
>;

export type ModelSummaryRow = {
  id: string;
  title: string;
  category: { id: string; name: string; slug: string } | null;
  tags: string[];
  owner: { id: string; name: string };
  sourceUrl: string | null;
  sourceRevision: string | null;
  coverImageId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ModelDetailRow = ModelSummaryRow & {
  description: string;
  files: FileRow[];
  bom: BomItemInput[];
  videos: ModelVideo[];
};

export const fileDownloadPath = (fileId: string) => `/api/v1/files/${fileId}`;

export function serializeFile(file: FileRow, url: UrlFor): ApiFileOut {
  return {
    id: file.id,
    kind: file.kind,
    filename: file.filename,
    size: file.size,
    contentType: file.contentType,
    position: file.position,
    imported: file.imported,
    generatedFromId: file.generatedFromId,
    downloadUrl: url(fileDownloadPath(file.id)),
    // Estimates only exist for sliceable files; null status means estimates don't apply (.step/.scad, images), which is different from "pending".
    print: file.sliceStatus
      ? {
          status: file.sliceStatus,
          source: file.sliceSource,
          approximate: isApproxEstimate(file),
          printTimeSeconds: file.printTimeSeconds,
          filamentGrams: file.filamentGrams,
          engine: file.sliceEngine,
          estimatedForPrinter: file.slicePrinter,
          error: file.sliceError,
          printer: printerInfoPayload(file.printerInfo),
        }
      : null,
  };
}

function source(row: ModelSummaryRow): ApiModelSummaryOut["source"] {
  const platform = platformFromSourceUrl(row.sourceUrl);
  if (!platform || !row.sourceUrl) return null;
  return { platform, url: row.sourceUrl, revision: row.sourceRevision };
}

export function serializeModelSummary(row: ModelSummaryRow, url: UrlFor): ApiModelSummaryOut {
  return {
    id: row.id,
    title: row.title,
    category: row.category
      ? { id: row.category.id, name: row.category.name, slug: row.category.slug }
      : null,
    tags: [...row.tags].sort(),
    owner: { id: row.owner.id, name: row.owner.name },
    source: source(row),
    coverImageUrl: row.coverImageId ? url(fileDownloadPath(row.coverImageId)) : null,
    url: url(`/models/${row.id}`),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeModel(row: ModelDetailRow, url: UrlFor): ApiModelOut {
  return {
    ...serializeModelSummary(row, url),
    description: row.description,
    files: [...row.files]
      .sort((a, b) => a.position - b.position)
      .map((file) => serializeFile(file, url)),
    bom: row.bom.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      link: item.link,
      imageUrl: item.imageUrl,
      section: item.section,
    })),
    videos: row.videos.map((v) => ({ url: v.url, position: v.position })),
  };
}

type CollectionRow = Pick<
  typeof collections.$inferSelect,
  "id" | "title" | "description" | "smart" | "sourceUrl" | "createdAt" | "updatedAt"
> & { owner: { id: string; name: string } };

export function serializeCollection(row: CollectionRow, url: UrlFor): ApiCollectionOut {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    smart: row.smart,
    owner: { id: row.owner.id, name: row.owner.name },
    sourceUrl: row.sourceUrl,
    url: url(`/collections/${row.id}`),
    modelsUrl: url(`/api/v1/models?collection=${row.id}`),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
