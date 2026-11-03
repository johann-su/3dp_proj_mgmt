// Request and response shapes of the public REST API (/api/v1) as zod schemas — the single source for request validation, the response types the serializers are checked against (src/lib/api/serialize.ts), and the OpenAPI document (src/lib/api/openapi.ts). Change a shape here and all three move together. Pure: no DB, no auth.
//
// Response schemas are documentation and types, not runtime checks: the serializers build them from rows we already trust. Request schemas are the gate in front of the mutation core, which still re-validates everything it cares about (BOM sanitizing, sourceUrl allowlist, file kinds).

import * as z from "zod";
import { MAX_BOM_ITEMS } from "@/lib/bom";
import { SOURCE_PLATFORMS } from "@/lib/sources/registry";

// Everything named here becomes a `components.schemas` entry.
export const apiSchemas = z.registry<{ id: string }>();

const id = z.uuid();
const timestamp = z.iso.datetime().meta({ description: "ISO 8601, UTC" });

// --- Shared -----------------------------------------------------------------

export const ApiError = z
  .object({
    error: z.string().meta({ description: "Human-readable; safe to show to a user" }),
    code: z.string().meta({
      description:
        "Stable machine-readable code: unauthorized, insufficient_scope, invalid_request, not_found, forbidden, duplicate, rate_limited, payload_too_large, internal",
    }),
    issues: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional()
      .meta({ description: "Per-field validation problems (invalid_request only)" }),
  })
  .register(apiSchemas, { id: "Error" });

export const ApiUserRef = z
  .object({ id: z.string(), name: z.string() })
  .register(apiSchemas, { id: "UserRef" });

export const ApiCategory = z
  .object({ id, name: z.string(), slug: z.string() })
  .register(apiSchemas, { id: "Category" });

export const ApiTag = z
  .object({ name: z.string(), modelCount: z.number().int() })
  .register(apiSchemas, { id: "Tag" });

export const ApiSource = z
  .object({
    platform: z.enum(SOURCE_PLATFORMS as [string, ...string[]]),
    url: z.string(),
    revision: z.string().nullable().meta({
      description:
        "Opaque upstream revision token at the last import/sync (Onshape: the workspace microversion); null when the source has none",
    }),
  })
  .register(apiSchemas, { id: "Source" });

// --- Files --------------------------------------------------------------------

export const ApiPrinterInfo = z
  .object({
    model: z.string().nullable(),
    nozzleDiameterMm: z.number().nullable(),
    bedType: z.string().nullable(),
    bedSizeMm: z.object({ x: z.number(), y: z.number() }).nullable(),
    filamentTypes: z.array(z.string()).meta({
      description: "One entry per filament slot the print uses, in slot order — not deduped",
    }),
    filamentColors: z.array(z.string()).meta({
      description: "Hex colours index-parallel to filamentTypes, or empty when not every slot has one",
    }),
    multiFilament: z.enum(["color", "material"]).nullable().meta({
      description: "Whether a single plate changes filament mid-print (needs an AMS/MMU)",
    }),
    missingFilamentSlots: z.array(z.number().int()),
    usesSupport: z.boolean().nullable().meta({ description: "null = the file didn't say" }),
    requiresMultiNozzle: z.boolean().nullable(),
  })
  .register(apiSchemas, { id: "PrinterInfo" });

export const ApiPrintEstimate = z
  .object({
    status: z.enum(["pending", "ok", "failed"]),
    source: z.enum(["embedded", "slicer"]).nullable().meta({
      description: "embedded = read from the file's own slice data; slicer = sliced by the server",
    }),
    approximate: z.boolean().meta({
      description: "The numbers assume a printer or settings the file didn't specify",
    }),
    printTimeSeconds: z.number().nullable(),
    filamentGrams: z.number().nullable(),
    engine: z.string().nullable(),
    estimatedForPrinter: z.string().nullable(),
    error: z.string().nullable(),
    printer: ApiPrinterInfo.nullable(),
  })
  .register(apiSchemas, { id: "PrintEstimate" });

export const ApiFile = z
  .object({
    id,
    kind: z.enum(["model", "image", "pdf", "video"]),
    filename: z.string(),
    size: z.number().int(),
    contentType: z.string(),
    position: z.number().int(),
    imported: z.boolean().meta({ description: "The bytes came from the model's source platform" }),
    generatedFromId: id.nullable().meta({
      description: "The .scad file this OpenSCAD variant was rendered from",
    }),
    downloadUrl: z.string().meta({ description: "GET with a files:read key" }),
    print: ApiPrintEstimate.nullable().meta({ description: "Slicer estimate; null for non-.3mf files" }),
  })
  .register(apiSchemas, { id: "File" });

// --- Models -------------------------------------------------------------------

export const ApiBomItem = z
  .object({
    name: z.string().min(1).max(500),
    quantity: z.string().max(100).default("1").meta({
      description: 'Free text on purpose: "4", "0.5 kg", "2 m"',
    }),
    link: z.string().max(2000).nullable().default(null),
    imageUrl: z.string().max(2000).nullable().default(null),
    section: z.string().max(200).nullable().default(null).meta({
      description: "Heading the item is grouped under; null = ungrouped",
    }),
  })
  .register(apiSchemas, { id: "BomItem" });

export const ApiVideo = z
  .object({ url: z.string(), position: z.number().int() })
  .register(apiSchemas, { id: "Video" });

export const ApiModelSummary = z
  .object({
    id,
    title: z.string(),
    category: ApiCategory.nullable(),
    tags: z.array(z.string()),
    owner: ApiUserRef,
    source: ApiSource.nullable(),
    coverImageUrl: z.string().nullable().meta({
      description: "The first gallery image (files:read to download)",
    }),
    url: z.string().meta({ description: "The model's page in the web app" }),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .register(apiSchemas, { id: "ModelSummary" });

export const ApiModel = ApiModelSummary.extend({
  description: z.string().meta({ description: "Markdown" }),
  files: z.array(ApiFile),
  bom: z.array(ApiBomItem),
  videos: z.array(ApiVideo),
}).register(apiSchemas, { id: "Model" });

export const ApiModelPage = z
  .object({
    data: z.array(ApiModelSummary),
    nextCursor: z.string().nullable().meta({ description: "Pass as ?cursor= for the next page; null = last page" }),
  })
  .register(apiSchemas, { id: "ModelPage" });

export const ApiDuplicate = z
  .object({ error: z.string(), code: z.literal("duplicate"), duplicates: z.array(
    z.object({ id, title: z.string(), url: z.string() }),
  ) })
  .register(apiSchemas, { id: "DuplicateConflict" });

// A staged upload, attached to a model on create/update. `upload` is the handle from POST /uploads.
const FileAttachment = z
  .object({
    upload: z.string().min(1).max(4096),
    slice: z.boolean().optional().meta({
      description: "Queue a .3mf for print estimates (default true)",
    }),
  })
  .strict()
  .register(apiSchemas, { id: "FileAttachment" });

const tags = z.array(z.string().max(100)).max(50);
const bom = z.array(ApiBomItem).max(MAX_BOM_ITEMS);

export const CreateModelBody = z
  .object({
    title: z.string().min(1).max(500),
    description: z.string().max(100_000).default(""),
    categoryId: id.nullable().optional().meta({ description: 'Omitted or null = "Other"' }),
    tags: tags.default([]),
    bom: bom.default([]),
    files: z.array(FileAttachment).min(1).max(200).meta({
      description: "At least one model file (.3mf, .scad, .step)",
    }),
    sourceUrl: z.string().max(2000).nullable().optional().meta({
      description: "A MakerWorld, Printables or Onshape link the model came from",
    }),
    confirmDuplicate: z.boolean().optional().meta({
      description: "Save even though a model file matches one already in the catalog",
    }),
  })
  .strict()
  .register(apiSchemas, { id: "CreateModel" });

export const UpdateModelBody = z
  .object({
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(100_000).optional(),
    categoryId: id.nullable().optional(),
    tags: tags.optional().meta({ description: "Replaces the model's tags" }),
    bom: bom.optional().meta({ description: "Replaces the model's BOM" }),
    addFiles: z.array(FileAttachment).max(200).optional(),
    removeFileIds: z.array(id).max(500).optional(),
    renameFiles: z
      .array(z.object({ id, filename: z.string().min(1).max(255) }).strict())
      .max(500)
      .optional(),
    confirmDuplicate: z.boolean().optional(),
  })
  .strict()
  .meta({ description: "Fields left out keep their current value" })
  .register(apiSchemas, { id: "UpdateModel" });

// --- Uploads --------------------------------------------------------------------

export const ApiUpload = z
  .object({
    upload: z.string().meta({ description: "Opaque handle; pass to files[].upload" }),
    filename: z.string(),
    size: z.number().int(),
    kind: z.enum(["model", "image", "pdf", "video"]),
    expiresAt: timestamp,
  })
  .register(apiSchemas, { id: "Upload" });

// --- Collections ----------------------------------------------------------------

export const ApiCollection = z
  .object({
    id,
    title: z.string(),
    description: z.string(),
    smart: z.boolean().meta({
      description: "Membership comes from rules; members can't be added or removed by hand",
    }),
    owner: ApiUserRef,
    sourceUrl: z.string().nullable(),
    url: z.string(),
    modelsUrl: z.string().meta({ description: "List its models: GET /models?collection=<id>" }),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .register(apiSchemas, { id: "Collection" });

export const ApiCollectionPage = z
  .object({ data: z.array(ApiCollection), nextCursor: z.string().nullable() })
  .register(apiSchemas, { id: "CollectionPage" });

// --- Me -------------------------------------------------------------------------

export const ApiMe = z
  .object({
    user: ApiUserRef.extend({ role: z.string() }),
    key: z.object({
      id: z.string(),
      name: z.string().nullable(),
      scopes: z.array(z.string()),
      expiresAt: timestamp.nullable(),
    }),
  })
  .register(apiSchemas, { id: "Me" });

export type ApiModelSummaryOut = z.output<typeof ApiModelSummary>;
export type ApiModelOut = z.output<typeof ApiModel>;
export type ApiFileOut = z.output<typeof ApiFile>;
export type ApiCollectionOut = z.output<typeof ApiCollection>;
export type CreateModelBodyIn = z.output<typeof CreateModelBody>;
export type UpdateModelBodyIn = z.output<typeof UpdateModelBody>;
