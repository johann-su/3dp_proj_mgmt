import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import type { RuleGroup } from "@/lib/collection-rules";
import type { BomItemInput } from "@/lib/bom";
import type { DuplicateVia } from "@/lib/duplicate-key";
import type { UserRole } from "@/lib/roles";

// --- BetterAuth tables ---

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // Instance-wide role (issue #54): moderators/admins pass the owner-only
  // gates on all models/collections, admins additionally manage users under
  // Settings → Users. See src/lib/roles.ts; first admin via src/lib/admin.ts.
  role: text("role").$type<UserRole>().notNull().default("user"),
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

// --- OAuth provider tables (BetterAuth `mcp` plugin, issue #96) ---
//
// The MCP server (/api/mcp) authenticates LLM clients with OAuth 2.1 bearer
// tokens instead of session cookies, so the instance acts as an authorization
// server for them. These three tables are BetterAuth's own (shared with its
// oidc-provider plugin) — the property names must stay exactly as spelled
// here, because the drizzle adapter looks each model/field up by name (see the
// `schema` map in src/lib/auth.ts). Only used while ENABLE_MCP is set.
//
// Clients register themselves (RFC 7591 dynamic client registration), so an
// oauthApplication row is created by whoever connects a client, not by an
// admin — hence the whole surface being opt-in per instance.

export const oauthApplication = pgTable("oauth_application", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  icon: text("icon"),
  metadata: text("metadata"),
  clientId: text("client_id").notNull().unique(),
  clientSecret: text("client_secret"),
  // Comma-joined list; an authorize request must match one exactly.
  redirectUrls: text("redirect_urls").notNull(),
  type: text("type").notNull(),
  disabled: boolean("disabled").notNull().default(false),
  // The user who registered the client, when it was registered from a session.
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const oauthAccessToken = pgTable("oauth_access_token", {
  id: text("id").primaryKey(),
  accessToken: text("access_token").notNull().unique(),
  refreshToken: text("refresh_token").notNull().unique(),
  accessTokenExpiresAt: timestamp("access_token_expires_at").notNull(),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at").notNull(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthApplication.clientId, { onDelete: "cascade" }),
  // Null after the user account is deleted — the token is then unusable
  // (getMcpSession resolves the user), so revocation comes for free.
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  scopes: text("scopes").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const oauthConsent = pgTable("oauth_consent", {
  id: text("id").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthApplication.clientId, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  scopes: text("scopes").notNull(),
  consentGiven: boolean("consent_given").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// --- Application tables ---

export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
  // Match keywords for category suggestion (src/lib/category-suggest.ts) —
  // compared against a model's title, tags and, on import, the source
  // platform's category names. Defaults live in src/lib/category-defaults.ts.
  keywords: text("keywords").array().notNull().default([]),
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
  // Soft delete ("trash"): a trashed model is hidden from every listing (the
  // queries add `deleted_at IS NULL`) but keeps its rows, versions and S3
  // objects so the owner can restore it from /models/trash. Purged for real
  // (rows + S3) after TRASH_RETENTION_DAYS — see src/lib/model-versions.ts.
  deletedAt: timestamp("deleted_at"),
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
// what a visitor needs to judge "can I print this on my setup". The filament
// arrays cover the slots the objects actually use, not every AMS slot.
export type PrinterInfo = {
  model?: string; // "Bambu Lab P1S"
  nozzleDiameterMm?: number;
  bedType?: string; // "Textured PEI Plate"
  // One entry per filament *slot* the objects print from, in slot order, and
  // deliberately not deduped: red PLA in slot 1 plus black PLA in slot 2 is a
  // two-colour print, and ["PLA"] would read as a single-colour one.
  filamentTypes?: string[]; // ["PLA", "PLA"]
  // Hex colours index-parallel to filamentTypes (Bambu/PrusaSlicer
  // `filament_colour`). Absent — rather than padded — when the config doesn't
  // give every used slot a colour, so the two arrays always zip 1:1.
  filamentColors?: string[]; // ["#e02020", "#000000"]
  // Whether the used slots sit on more than one *physical* extruder, i.e. the
  // print needs a dual-nozzle/toolchanger machine (H2D, Prusa XL, IDEX) rather
  // than many filaments multiplexed through one nozzle by an AMS/MMU — a
  // materially different answer to "can I print this". Undefined when the
  // config doesn't say, like usesSupport.
  requiresMultiNozzle?: boolean;
  // Whether the project was set up to print support material (Bambu/Orca
  // `enable_support`, PrusaSlicer `support_material`). Undefined when the
  // config doesn't say — "does this need supports?" is one of the first
  // questions about a print, and the answer is already in the file.
  usesSupport?: boolean;
  // Physical build-plate size in mm (bounding box of the bed shape), so the 3D
  // preview can draw a real bed the geometry is measured against (issue #80).
  // Parsed from the embedded config's printable area (Bambu `printable_area` /
  // PrusaSlicer `bed_shape`), falling back to a known-model lookup when the
  // config lacks a usable shape. { x: 256, y: 256 }
  bedSizeMm?: { x: number; y: number };
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
  // Provenance: the file's bytes came from the model's source platform (URL
  // import, Onshape export, collection import) rather than a manual upload.
  // Shown as a badge on the model page and edit form, and scopes what the
  // MakerWorld/Printables source sync may touch; Onshape sync keeps selecting
  // its replaceable files via onshapeElementId.
  imported: boolean("imported").notNull().default(false),
  // Upstream identity for MakerWorld/Printables source sync (issue-less
  // sibling of onshapeElementId): "profile:<id>" (MakerWorld print profile),
  // "scad:<name>" (raw-file OpenSCAD source), "doc:<name>" (attached PDF) or
  // "file:<id>" (Printables file). Sync matches local imported files to
  // upstream by this id, so local renames don't break the link. Null for
  // manual uploads, Onshape exports and imports predating the feature (the
  // first sync adopts those by filename).
  sourceFileId: text("source_file_id"),
  // Opaque upstream last-modified token (an ISO date string as the platform
  // sends it — Printables per-file `modified`, MakerWorld per-profile
  // `publishTime` / raw-file `modelUpdateTime`). Sync compares it for
  // equality against the current upstream value; an unchanged token skips
  // the download. Never parsed except by the legacy-adopt heuristic —
  // MakerWorld's design-level updateTime is deliberately NOT used (it is
  // touched by counters, not content edits). Onshape reuses this slot for the
  // per-element microversion (issue #70): the element's opaque change token,
  // compared for equality so an unchanged tab is skipped by onshape-sync. The
  // two never collide — an Onshape file has no sourceFileId and its model's
  // sourceUrl isn't a MakerWorld/Printables URL, so source-sync never sees it.
  sourceModifiedAt: text("source_modified_at"),
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
  // Who generated this variant — a signed-in user, not necessarily the model
  // owner (customizing is open to everyone). Lets a non-owner delete their own
  // variants while the owner can delete any. Null for non-generated files and
  // legacy variants; set null on user deletion so their variants survive.
  generatedBy: text("generated_by").references(() => user.id, {
    onDelete: "set null",
  }),
  // Incremented each time this file is served as a download (kind "model",
  // or an image/pdf fetched with ?download=1) — see src/lib/metrics.ts.
  // Inline image views (gallery thumbnails, next/image) don't count.
  downloadCount: integer("download_count").notNull().default(0),
  // Lowercase hex SHA-256 of the stored bytes, computed while streaming to S3
  // (src/lib/storage.ts) and used to flag a re-uploaded model file as a
  // duplicate (issue #118). Only set for kind "model": images and PDFs are
  // legitimately shared between models. Null on generated OpenSCAD variants
  // (they have generatedParamsHash) and on every row inserted before the
  // column existed — a null hash simply never matches.
  //
  // A raw byte hash under-detects on purpose: the same geometry re-exported by
  // a slicer differs in its embedded timestamp/thumbnail/project_settings, so
  // it won't hash-equal. That catches the common "uploaded the exact same
  // file again" case; a mesh-level fingerprint is a deliberate follow-up.
  contentHash: text("content_hash"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  // The duplicate lookup runs on every save; without this it seq-scans every
  // file row in the instance.
  index("model_files_content_hash_idx").on(t.contentHash),
]);

// --- Model versioning (issue #55) ---
//
// Every completed mutation of a model (create, edit, Onshape sync, revert)
// appends one model_versions row holding a full JSON snapshot of the mutable
// state. model_files stays "the live files only" — a removed file's row is
// deleted as before, but its S3 object is kept as long as any snapshot still
// references its s3Key, and reverting re-inserts the row from the snapshot.
// That keeps every existing query untouched (nothing needs to filter out
// historical rows) at the cost of file ids/download counts not surviving a
// remove+revert round trip. Generated OpenSCAD variants are excluded from
// snapshots on purpose: they are additive, individually deletable, and cheap
// to regenerate. Version rows are capped per model; pruning deletes S3
// objects no longer referenced by any remaining snapshot or live file — see
// src/lib/model-versions.ts.

export type ModelVersionReason =
  | "create"
  | "edit"
  | "onshape-sync"
  | "source-sync"
  | "revert";

// One file as recorded in a snapshot, in display order. Everything needed to
// re-insert the model_files row on revert; the bytes stay at s3Key.
export type VersionFileSnapshot = {
  kind: FileKind;
  filename: string;
  s3Key: string;
  size: number;
  contentType: string;
  animated: boolean;
  onshapeElementId: string | null;
  imported: boolean;
  sourceFileId: string | null;
  sourceModifiedAt: string | null;
  contentHash: string | null;
  sliceStatus: SliceStatus | null;
  sliceSource: SliceSource | null;
  printTimeSeconds: number | null;
  filamentGrams: number | null;
  sliceError: string | null;
  printerInfo: PrinterInfo | null;
};

export type ModelVersionSnapshot = {
  title: string;
  description: string;
  categoryId: string | null;
  tags: string[];
  bom: BomItemInput[];
  files: VersionFileSnapshot[];
};

export const modelVersions = pgTable("model_versions", {
  // Identity (not uuid): versions created in the same transaction share a
  // now() timestamp, so insertion order is the only reliable version order.
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  modelId: uuid("model_id")
    .notNull()
    .references(() => models.id, { onDelete: "cascade" }),
  // Who saved this version; null after the user account is deleted.
  editorUserId: text("editor_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  reason: text("reason").$type<ModelVersionReason>().notNull(),
  snapshot: jsonb("snapshot").$type<ModelVersionSnapshot>().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// --- Duplicate detection (issue #118) ---
//
// One dismissed duplicate flag: the user was told `model_id` looks like a copy
// of `duplicate_of_id` and imported/saved it anyway. Detection is flag-only —
// nothing is blocked and nothing is merged automatically (the whole catalog is
// collaboratively editable, so a copy is a cleanup task, not an error), so the
// rows exist purely to give a moderator a worklist: Settings → Duplicates.
//
// A table rather than a column on `models`: a model can accumulate several
// dismissed matches over time, and each carries its own signal and timestamp.
// Resolving a row means deleting it (the model is trashed, or the match is
// dismissed as a false positive); both sides cascade, so trashing-then-purging
// either model cleans up after itself.
export const modelDuplicates = pgTable(
  "model_duplicates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The newly added copy — the one a moderator would trash.
    modelId: uuid("model_id")
      .notNull()
      .references(() => models.id, { onDelete: "cascade" }),
    // The model that was already there.
    duplicateOfId: uuid("duplicate_of_id")
      .notNull()
      .references(() => models.id, { onDelete: "cascade" }),
    detectedVia: text("detected_via").$type<DuplicateVia>().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // Re-recording the same match is a no-op (an edit that re-adds the same
    // file shouldn't stack up rows) — writers rely on onConflictDoNothing.
    uniqueIndex("model_duplicates_pair_idx").on(
      t.modelId,
      t.duplicateOfId,
      t.detectedVia,
    ),
  ],
);

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

// Per-user "likes"/favorites: a signed-in user can like any model for quick
// access from /models/liked. Like collection_models, membership is a join row
// keyed by (user, model); the row's created_at orders the liked list (most
// recently liked first). Cascades with either side, so deleting a user or a
// model drops its likes. Trashed models keep their like rows but are hidden
// from the listing (the /models/liked query filters deleted_at IS NULL).
export const modelLikes = pgTable(
  "model_likes",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    modelId: uuid("model_id")
      .notNull()
      .references(() => models.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.modelId] })],
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
  likes: many(modelLikes),
  versions: many(modelVersions),
}));

export const modelLikesRelations = relations(modelLikes, ({ one }) => ({
  model: one(models, { fields: [modelLikes.modelId], references: [models.id] }),
  user: one(user, { fields: [modelLikes.userId], references: [user.id] }),
}));

export const modelVersionsRelations = relations(modelVersions, ({ one }) => ({
  model: one(models, {
    fields: [modelVersions.modelId],
    references: [models.id],
  }),
  editor: one(user, {
    fields: [modelVersions.editorUserId],
    references: [user.id],
  }),
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

// Joined on client_id rather than the primary key — that is the column the
// token row carries (and it is unique). Only used by the "connected apps"
// list in Settings; BetterAuth reaches these tables through its own adapter.
export const oauthAccessTokenRelations = relations(oauthAccessToken, ({ one }) => ({
  client: one(oauthApplication, {
    fields: [oauthAccessToken.clientId],
    references: [oauthApplication.clientId],
  }),
}));
