// The catalog tools the MCP server exposes (issue #96). Everything here is
// read-only and metadata-only: the questions this is meant to answer — "which
// material should I print this in", "does it need supports", "what does the
// BOM cost", "how long will it take" — are all answered from rows the app
// already has, plus links the calling model can follow itself.
//
// Two things are deliberately NOT here:
//   * mesh/geometry bytes (.3mf/.step). Useless to a language model, and the
//     one file type that is worth reading — the manual — is handed over as a
//     URL instead.
//   * scraped BOM prices. Each item carries its vendor link; a client with web
//     access reads the current price better than per-vendor parsing here would.
//
// Access is exactly the browser's: every signed-in user may read the whole
// catalog (docs/architecture/auth-and-access.md), so holding a token for any
// user is the same grant. The route checks the token; these functions assume it.

import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { PrinterInfo } from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { groupBySection } from "@/lib/bom";
import { ruleTreeToSql, type RuleNode } from "@/lib/collection-rules";
import { namedFileSrc } from "@/lib/file-token";
import { formatDuration } from "@/lib/format";
import {
  optionalInt,
  optionalString,
  optionalStringArray,
  requireUuid,
  ToolError,
  type McpTool,
} from "@/lib/mcp/protocol";

const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;
// Matches the per-model cap in normalizeTagNames (src/lib/tags.ts) — more tags
// than a model can carry can only ever narrow the search to nothing.
const MAX_TAG_FILTER = 20;
// Long descriptions are the exception, but a hit list of twenty full ones
// would crowd out the answer; get_model returns the whole text.
const SUMMARY_CHARS = 400;

// Every model-shaped answer carries the page URL: it is what a person is
// ultimately sent to, and it lets the model cite its source.
function modelUrl(id: string): string {
  return appUrl(`/models/${id}`).toString();
}

// An LLM client's own "fetch this URL" step may decide how (or whether) to
// handle a link by its apparent extension, so every file URL handed to MCP
// clients is named rather than a bare UUID — see namedFileSrc.
function absoluteNamedFileUrl(fileId: string, filename: string): string {
  return appUrl(namedFileSrc(fileId, filename)).toString();
}

function summarize(description: string): string | null {
  const text = description.trim();
  if (!text) return null;
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}…` : text;
}

// --- search_models ---------------------------------------------------------

// Category is named, not id'd: a model asking for "the enclosure category"
// has a word, not a UUID. Slug and name both resolve, case-insensitively.
async function resolveCategoryId(name: string): Promise<string> {
  const wanted = name.trim().toLowerCase();
  const categories = await db.query.categories.findMany({
    columns: { id: true, name: true, slug: true },
  });
  const match = categories.find(
    (c) => c.name.toLowerCase() === wanted || c.slug.toLowerCase() === wanted,
  );
  if (!match) {
    throw new ToolError(
      `No category named "${name}". Available: ${categories
        .map((c) => c.name)
        .sort()
        .join(", ")}`,
    );
  }
  return match.id;
}

type SearchRow = {
  id: string;
  title: string;
  description: string;
  source_url: string | null;
  category: string | null;
  tags: string[] | null;
  thumbnail_id: string | null;
  thumbnail_filename: string | null;
};

async function searchModels(args: Record<string, unknown>) {
  const query = optionalString(args, "query");
  const category = optionalString(args, "category");
  const tags = optionalStringArray(args, "tags").slice(0, MAX_TAG_FILTER);
  const limit = optionalInt(args, "limit", {
    min: 1,
    max: SEARCH_MAX_LIMIT,
    fallback: SEARCH_DEFAULT_LIMIT,
  });

  // Reuses the smart-collection rule compiler (src/lib/collection-rules.ts) so
  // MCP filtering matches what the app's own saved searches do — including the
  // typo-tolerant trigram text match.
  const conditions: RuleNode[] = [];
  if (query) conditions.push({ field: "text", value: query });
  if (category) {
    conditions.push({ field: "category", value: await resolveCategoryId(category) });
  }
  if (tags.length > 0) {
    conditions.push({
      field: "tags",
      op: "any",
      value: tags.map((t) => t.toLowerCase()),
    });
  }

  // Trashed models are hidden from every listing; an empty filter set is a
  // plain "newest models" browse.
  const where =
    conditions.length > 0
      ? sql`m.deleted_at IS NULL AND ${ruleTreeToSql({ op: "AND", rules: conditions })}`
      : sql`m.deleted_at IS NULL`;
  // With a query term the best text match should come first (same expression
  // /search ranks with); without one, recency is the only sensible order.
  const orderBy = query
    ? sql`GREATEST(strict_word_similarity(${query}, m.title), strict_word_similarity(${query}, m.description)) DESC, m.created_at DESC`
    : sql`m.created_at DESC`;

  const { rows } = await db.execute<SearchRow>(sql`
    SELECT m.id, m.title, m.description, m.source_url,
           c.name AS category,
           ARRAY(SELECT t.name FROM model_tags mt JOIN tags t ON t.id = mt.tag_id
                 WHERE mt.model_id = m.id ORDER BY t.name) AS tags,
           (SELECT mf.id FROM model_files mf WHERE mf.model_id = m.id AND mf.kind = 'image'
            ORDER BY mf.position ASC LIMIT 1) AS thumbnail_id,
           (SELECT mf.filename FROM model_files mf WHERE mf.model_id = m.id AND mf.kind = 'image'
            ORDER BY mf.position ASC LIMIT 1) AS thumbnail_filename
    FROM models m
    LEFT JOIN categories c ON c.id = m.category_id
    WHERE ${where}
    ORDER BY ${orderBy}, m.id DESC
    LIMIT ${limit}
  `);

  return {
    models: rows.map((row) => ({
      modelId: row.id,
      title: row.title,
      summary: summarize(row.description),
      category: row.category,
      tags: row.tags ?? [],
      sourceUrl: row.source_url,
      url: modelUrl(row.id),
      thumbnailUrl:
        row.thumbnail_id && row.thumbnail_filename
          ? absoluteNamedFileUrl(row.thumbnail_id, row.thumbnail_filename)
          : null,
    })),
    count: rows.length,
    truncated: rows.length === limit,
  };
}

// --- per-model lookups -----------------------------------------------------

// Shared first step of every get_model_* tool: resolve the id or fail with a
// message that tells the model what to do about it.
async function requireModel(args: Record<string, unknown>) {
  const modelId = requireUuid(args, "modelId");
  const model = await db.query.models.findFirst({
    where: (m, { and, eq, isNull }) => and(eq(m.id, modelId), isNull(m.deletedAt)),
    with: {
      user: { columns: { name: true } },
      category: { columns: { name: true } },
      modelTags: { with: { tag: { columns: { name: true } } } },
    },
  });
  if (!model) {
    throw new ToolError(
      `No model with id ${modelId} (it may have been deleted). Use search_models to find the current id.`,
    );
  }
  return model;
}

async function getModel(args: Record<string, unknown>) {
  const model = await requireModel(args);
  // Counts, not contents: they tell the model which of the other tools is
  // worth calling for this particular model.
  const [{ rows: counts }, { rows: bom }] = await Promise.all([
    db.execute<{ kind: string; n: number }>(sql`
      SELECT kind, COUNT(*)::int AS n FROM model_files
      WHERE model_id = ${model.id} AND generated_from_id IS NULL
      GROUP BY kind
    `),
    db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM bom_items WHERE model_id = ${model.id}`,
    ),
  ]);
  const countFor = (kind: string) => counts.find((c) => c.kind === kind)?.n ?? 0;

  return {
    modelId: model.id,
    title: model.title,
    // Markdown as authored — assembly notes, print settings and warnings all
    // live in here, so it is passed through whole rather than summarized.
    description: model.description,
    category: model.category?.name ?? null,
    tags: model.modelTags.map((mt) => mt.tag.name),
    // Where it came from (MakerWorld/Printables/Onshape), if imported.
    sourceUrl: model.sourceUrl,
    owner: model.user.name,
    url: modelUrl(model.id),
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
    available: {
      bomItems: bom[0]?.n ?? 0,
      printFiles: countFor("model"),
      documents: countFor("pdf"),
      images: countFor("image"),
    },
  };
}

async function getModelBom(args: Record<string, unknown>) {
  const model = await requireModel(args);
  const items = await db.query.bomItems.findMany({
    where: (b, { eq }) => eq(b.modelId, model.id),
    orderBy: (b, { asc }) => asc(b.position),
  });

  return {
    modelId: model.id,
    title: model.title,
    // Same grouping the model page shows: ungrouped items first, then each
    // section in the order it first appears.
    sections: groupBySection(items).map((group) => ({
      section: group.section,
      items: group.items.map((item) => ({
        name: item.name,
        // Free text on purpose ("4", "0.5 kg", "2 m") — not a number.
        quantity: item.quantity,
        link: item.link,
        imageUrl: item.imageUrl,
      })),
    })),
    itemCount: items.length,
    note: "Prices are not stored. To cost a build, follow each item's link.",
  };
}

// The slicer writes estimates onto the file row; printer_info describes the
// hardware the project was set up for. Both may be absent (a .step file, an
// upload that predates the slicer, an instance with no SLICER_URL).
function printerPayload(info: PrinterInfo | null) {
  if (!info) return null;
  return {
    model: info.model ?? null,
    nozzleDiameterMm: info.nozzleDiameterMm ?? null,
    bedType: info.bedType ?? null,
    bedSizeMm: info.bedSizeMm ?? null,
    filamentTypes: info.filamentTypes ?? [],
    // undefined = the embedded config didn't say, which is not the same as "no
    // supports" — keep the distinction instead of defaulting it to false.
    usesSupport: info.usesSupport ?? null,
  };
}

async function getModelPrintFiles(args: Record<string, unknown>) {
  const model = await requireModel(args);
  const files = await db.query.modelFiles.findMany({
    where: (f, { and, eq, isNull }) =>
      // Generated OpenSCAD variants are parameter-specific renders of a file
      // that is already listed; including them would double the totals.
      and(eq(f.modelId, model.id), eq(f.kind, "model"), isNull(f.generatedFromId)),
    orderBy: (f, { asc }) => asc(f.position),
  });

  let printTimeSeconds: number | null = null;
  let filamentGrams: number | null = null;
  for (const file of files) {
    if (file.printTimeSeconds !== null) {
      printTimeSeconds = (printTimeSeconds ?? 0) + file.printTimeSeconds;
    }
    if (file.filamentGrams !== null) {
      filamentGrams = (filamentGrams ?? 0) + file.filamentGrams;
    }
  }

  return {
    modelId: model.id,
    title: model.title,
    files: files.map((file) => ({
      filename: file.filename,
      sizeBytes: file.size,
      // "ok" numbers are either read from the file's own slice_info (exact,
      // sliceSource "embedded") or produced by the headless slicer
      // (approximate); "pending" means no estimate yet, "failed" that the file
      // could not be sliced, null that estimates don't apply (.step/.scad).
      sliceStatus: file.sliceStatus,
      sliceSource: file.sliceSource,
      sliceError: file.sliceError,
      printTimeSeconds: file.printTimeSeconds,
      printTime: file.printTimeSeconds !== null ? formatDuration(file.printTimeSeconds) : null,
      filamentGrams: file.filamentGrams,
      printerInfo: printerPayload(file.printerInfo),
    })),
    totals: {
      printTimeSeconds,
      printTime: printTimeSeconds !== null ? formatDuration(printTimeSeconds) : null,
      filamentGrams,
    },
    note: "Estimates from the headless slicer are approximate; those read from a file sliced in Bambu Studio/OrcaSlicer are the slicer's own numbers.",
  };
}

async function getModelDocuments(args: Record<string, unknown>) {
  const model = await requireModel(args);
  const files = await db.query.modelFiles.findMany({
    where: (f, { and, eq }) => and(eq(f.modelId, model.id), eq(f.kind, "pdf")),
    orderBy: (f, { asc }) => asc(f.position),
  });

  return {
    modelId: model.id,
    title: model.title,
    documents: files.map((file) => ({
      filename: file.filename,
      sizeBytes: file.size,
      // A signed, expiring URL (src/lib/file-token.ts) — the only way to hand
      // a file to a client that has no session cookie. Anyone holding the URL
      // can fetch that one file until it expires. Named (not the bare-UUID
      // form) so a client's own fetch step can tell from the URL that this is
      // a PDF worth reading.
      downloadUrl: absoluteNamedFileUrl(file.id, file.filename),
    })),
    documentCount: files.length,
    note: "Fetch a downloadUrl to read the manual; the links expire.",
  };
}

// --- Tool definitions ------------------------------------------------------

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  // Everything served here comes from this instance's own database.
  openWorldHint: false,
} as const;

const MODEL_ID_SCHEMA = {
  type: "object",
  properties: {
    modelId: {
      type: "string",
      description: "Model id (UUID) as returned by search_models.",
    },
  },
  required: ["modelId"],
  additionalProperties: false,
} as const;

export const catalogTools: McpTool[] = [
  {
    name: "search_models",
    title: "Search models",
    description:
      "Find 3D models in the catalog by name, category or tags, and get their ids. " +
      "Text matching is typo-tolerant and covers title, description and tags. " +
      "Call this first — every other tool takes a model id.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free text matched against title, description and tags.",
        },
        category: {
          type: "string",
          description: "Category name or slug, e.g. \"Functional\". Must be one that exists.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Only models carrying at least one of these tags.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: SEARCH_MAX_LIMIT,
          default: SEARCH_DEFAULT_LIMIT,
          description: "Maximum number of models to return.",
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    run: searchModels,
  },
  {
    name: "get_model",
    title: "Get model details",
    description:
      "Full description and metadata for one model: the author's own text (assembly notes, " +
      "recommended settings), category, tags, where it was imported from, and how many BOM " +
      "items, print files and manuals it has.",
    inputSchema: MODEL_ID_SCHEMA,
    annotations: READ_ONLY,
    run: getModel,
  },
  {
    name: "get_model_bom",
    title: "Get bill of materials",
    description:
      "The parts needed to build a model, grouped into the sections the author defined, each " +
      "with a quantity and (usually) a vendor link. Prices are not stored — follow the links " +
      "to cost a build.",
    inputSchema: MODEL_ID_SCHEMA,
    annotations: READ_ONLY,
    run: getModelBom,
  },
  {
    name: "get_model_print_files",
    title: "Get print files and estimates",
    description:
      "Printable files with their slicer estimates and the hardware each project was set up " +
      "for: print time, filament weight, printer model, nozzle, build plate, filament types " +
      "and whether support material is enabled. Use this for \"what material\", \"does it need " +
      "supports\" and \"how long does it take\".",
    inputSchema: MODEL_ID_SCHEMA,
    annotations: READ_ONLY,
    run: getModelPrintFiles,
  },
  {
    name: "get_model_documents",
    title: "Get manuals and documents",
    description:
      "PDF manuals and other documents attached to a model, each with a temporary download " +
      "URL. Fetch the URL to read the document — assembly and wiring instructions usually " +
      "live there rather than in the description.",
    inputSchema: MODEL_ID_SCHEMA,
    annotations: READ_ONLY,
    run: getModelDocuments,
  },
];

// Sent once at initialize. Aimed at the model, not the user: it states the
// shape of the data and the one workflow that isn't obvious from the schemas.
export const CATALOG_INSTRUCTIONS = [
  "This server exposes a private, self-hosted 3D-printing catalog (Print Vault).",
  "Resolve a model with search_models first, then call the get_model_* tools with its id.",
  "Costs and assembly effort are not stored: follow BOM item links for prices, and fetch a",
  "document's downloadUrl to read the manual. Print estimates marked sliceSource \"slicer\"",
  "are approximations, not the printer's own numbers.",
].join(" ");
