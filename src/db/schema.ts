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
  // makerworld/printables URL this model was imported from
  sourceUrl: text("source_url"),
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
  createdAt: timestamp("created_at").notNull().defaultNow(),
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
