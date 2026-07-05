import {
  bigint,
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

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

// Per-user Onshape API key (created at dev-portal.onshape.com/keys), used to
// import and sync models from Onshape. The secret key is stored encrypted at
// rest — see src/lib/crypto.ts.
export const onshapeCredentials = pgTable("onshape_credentials", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  // Display name/email resolved from Onshape when the key was saved.
  account: text("account").notNull(),
  accessKey: text("access_key").notNull(),
  secretKeyCipher: text("secret_key_cipher").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type FileKind = "model" | "image";

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
  position: integer("position").notNull().default(0),
  // Onshape element this file was exported from; sync replaces these files.
  onshapeElementId: text("onshape_element_id"),
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
