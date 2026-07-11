import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import type { RuleGroup } from "@/lib/collection-rules";

// --- BetterAuth tables ---

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// --- Application tables ---

export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
});

export const models = pgTable("models", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  categoryId: uuid("category_id").references(() => categories.id, {
    onDelete: "set null",
  }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  // makerworld/printables/onshape URL this model was imported from. For
  // Onshape it is the canonical document pin
  // (…/documents/{did}/w|v/{wvmid}[/e/{eid}]) that sync re-exports from.
  sourceUrl: text("source_url"),
  // Microversion of the Onshape workspace at the last import/sync; null for
  // models not imported from Onshape (and for version-pinned imports, which
  // are immutable snapshots).
  onshapeMicroversion: text("onshape_microversion"),
  // Page view count, incremented on each model detail page load — see
  // src/lib/metrics.ts. Not surfaced in the UI yet.
  viewCount: integer("view_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Per-user Bambu Cloud credential, used to download MakerWorld .3mf files
// (which require an authenticated Bambu account). The access token is stored
// encrypted at rest — see src/lib/crypto.ts.
export const bambuCredentials = pgTable("bambu_credentials", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  account: text("account").notNull(),
  region: text("region").$type<"global" | "china">().notNull().default("global"),
  tokenCipher: text("token_cipher").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Per-user Onshape OAuth2 tokens ("Sign in with Onshape", see
// src/lib/onshape/oauth.ts), used to import and sync models from Onshape.
// Both tokens are stored encrypted at rest — see src/lib/crypto.ts. The
// refresh token is rotated on every access-token refresh.
export const onshapeCredentials = pgTable("onshape_credentials", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  // Display name/email resolved from Onshape when the account was connected.
  account: text("account").notNull(),
  accessTokenCipher: text("access_token_cipher").notNull(),
  refreshTokenCipher: text("refresh_token_cipher").notNull(),
  accessTokenExpiresAt: timestamp("access_token_expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type FileKind = "model" | "image" | "pdf";

// Print-estimate lifecycle of a .3mf model file (see src/lib/slicer.ts):
// pending  queued for the slicer service (or the service is unreachable)
// ok       estimates present — read from embedded Bambu slice_info metadata
//          ("embedded") or produced by the headless slicer ("slicer")
// failed   the slicer could not slice the file (sliceError has the reason)
// null     not applicable (images, pdfs, .step files, uploads that predate
//          the slicer feature)
export type SliceStatus = "pending" | "ok" | "failed";
export type SliceSource = "embedded" | "slicer";

// The hardware a .3mf project was set up for, extracted from its embedded
// slicer config (Bambu/Orca project_settings.config or PrusaSlicer
// Slic3r_PE.config) — see get3mfPrinterInfo in src/lib/threemf-remote.ts.
// Deliberately not the full process settings (layer height, infill, …): only
// what a visitor needs to judge "can I print this on my setup". filamentTypes
// lists the filaments the objects actually use, not every AMS slot.
export type PrinterInfo = {
  model?: string; // "Bambu Lab P1S"
  nozzleDiameterMm?: number;
  bedType?: string; // "Textured PEI Plate"
  filamentTypes?: string[]; // ["PETG"]
};

export const modelFiles = pgTable("model_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  modelId: uuid("model_id")
    .notNull()
    .references(() => models.id, { onDelete: "cascade" }),
  kind: text("kind").$type<FileKind>().notNull(),
  filename: text("filename").notNull(),
  s3Key: text("s3_key").notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  contentType: text("content_type").notNull(),
  // Animated GIF/WebP/PNG cover? Detected from the header at insert time
  // (content type can't tell), so browse cards freeze it to a poster frame.
  animated: boolean("animated").notNull().default(false),
  position: integer("position").notNull().default(0),
  // Onshape element this file was exported from; sync replaces these files.
  onshapeElementId: text("onshape_element_id"),
  sliceStatus: text("slice_status").$type<SliceStatus>(),
  sliceSource: text("slice_source").$type<SliceSource>(),
  printTimeSeconds: integer("print_time_seconds"),
  filamentGrams: real("filament_grams"),
  sliceError: text("slice_error"),
  printerInfo: jsonb("printer_info").$type<PrinterInfo>(),
  // Set on a .3mf rendered from a parametric .scad file (see
  // src/app/api/models/[id]/customize): the source file row, the customizer
  // values used, and a hash of those values so re-generating an identical
  // parameter set returns the existing file instead of re-rendering. The FK
  // cascade removes variant rows with their source, but S3 objects must be
  // deleted explicitly (updateModel/deleteModel handle that).
  generatedFromId: uuid("generated_from_id").references(
    (): AnyPgColumn => modelFiles.id,
    { onDelete: "cascade" },
  ),
  generatedParams: jsonb("generated_params").$type<Record<string, string>>(),
  generatedParamsHash: text("generated_params_hash"),
  // Incremented each time this file is served as a download (kind "model",
  // or an image/pdf fetched with ?download=1) — see src/lib/metrics.ts.
  // Inline image views (gallery thumbnails, next/image) don't count.
  downloadCount: integer("download_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Bill of materials: filament, heat set inserts, screws, …
export const bomItems = pgTable("bom_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  modelId: uuid("model_id")
    .notNull()
    .references(() => models.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // free-form so "4", "0.5 kg" and "2 m" all work
  quantity: text("quantity").notNull().default("1"),
  link: text("link"),
  imageUrl: text("image_url"),
  // Optional user-named section ("Electronics", "Screws", …); null items are
  // ungrouped. Ordering comes from `position`; sections are contiguous runs.
  section: text("section"),
  position: integer("position").notNull().default(0),
});

export const tags = pgTable("tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
});

export const modelTags = pgTable(
  "model_tags",
  {
    modelId: uuid("model_id")
      .notNull()
      .references(() => models.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.modelId, t.tagId] })],
);

export const collections = pgTable("collections", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  // MakerWorld collection URL this collection was bulk-imported from; null
  // for hand-made collections. "Sync" re-runs the import job against it.
  sourceUrl: text("source_url"),
  // Smart collection: membership is defined by `rules` (a validated AND/OR
  // rule tree, see src/lib/collection-rules.ts) evaluated against model
  // metadata at read time — collection_models rows are ignored while smart.
  // Mutually exclusive with sourceUrl (imported collections mirror an
  // external list instead).
  smart: boolean("smart").notNull().default(false),
  rules: jsonb("rules").$type<RuleGroup>(),
  // Page view count, incremented on each collection page load — see
  // src/lib/metrics.ts. Not surfaced in the UI yet.
  viewCount: integer("view_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const collectionModels = pgTable(
  "collection_models",
  {
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    modelId: uuid("model_id")
      .notNull()
      .references(() => models.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.modelId] })],
);

// Lifecycle of a bulk import (MakerWorld collection import): the job runs in
// the background after POST /api/import/collection responds (next/server
// `after`), models land in `collectionId` as they finish, and the header
// progress indicator polls GET /api/import-jobs. "canceled" is set by the
// user; the runner checks for it between designs and stops.
export type ImportJobStatus = "running" | "done" | "failed" | "canceled";

export const importJobs = pgTable("import_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  // The MakerWorld collection URL the job was started from.
  sourceUrl: text("source_url").notNull(),
  // Local collection the imported models are added to.
  collectionId: uuid("collection_id").references(() => collections.id, {
    onDelete: "set null",
  }),
  status: text("status").$type<ImportJobStatus>().notNull().default("running"),
  // Number of designs the job will attempt (listed, non-hidden designs).
  total: integer("total").notNull().default(0),
  // Designs finished so far: imported + skipped (already imported) + failed.
  completed: integer("completed").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  // Title of the design currently being imported, for the progress UI.
  currentItem: text("current_item"),
  // Fatal error that stopped the whole job (per-design problems go to
  // `warnings` instead).
  error: text("error"),
  warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Doubles as the heartbeat: a "running" job whose updatedAt is stale was
  // killed by a server restart and gets marked failed on the next poll.
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// --- Relations ---

export const modelsRelations = relations(models, ({ one, many }) => ({
  user: one(user, { fields: [models.userId], references: [user.id] }),
  category: one(categories, {
    fields: [models.categoryId],
    references: [categories.id],
  }),
  files: many(modelFiles),
  bomItems: many(bomItems),
  modelTags: many(modelTags),
  collectionModels: many(collectionModels),
}));

export const collectionsRelations = relations(collections, ({ one, many }) => ({
  user: one(user, { fields: [collections.userId], references: [user.id] }),
  collectionModels: many(collectionModels),
}));

export const collectionModelsRelations = relations(collectionModels, ({ one }) => ({
  collection: one(collections, {
    fields: [collectionModels.collectionId],
    references: [collections.id],
  }),
  model: one(models, {
    fields: [collectionModels.modelId],
    references: [models.id],
  }),
}));

export const bomItemsRelations = relations(bomItems, ({ one }) => ({
  model: one(models, { fields: [bomItems.modelId], references: [models.id] }),
}));

export const modelFilesRelations = relations(modelFiles, ({ one }) => ({
  model: one(models, { fields: [modelFiles.modelId], references: [models.id] }),
}));

export const modelTagsRelations = relations(modelTags, ({ one }) => ({
  model: one(models, { fields: [modelTags.modelId], references: [models.id] }),
  tag: one(tags, { fields: [modelTags.tagId], references: [tags.id] }),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  modelTags: many(modelTags),
}));

export const categoriesRelations = relations(categories, ({ many }) => ({
  models: many(models),
}));
