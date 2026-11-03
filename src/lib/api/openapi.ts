// The OpenAPI 3.1 description of /api/v1, served at /api/v1/openapi.json.
// Component schemas are generated from the zod schemas the routes validate
// with (src/lib/api/schemas.ts), so the document can't drift from what the
// API accepts; the path table below is hand-written and unit-tested to
// reference only schemas that exist and to name every operation's scope.
// Pure — the server URL is passed in.

import * as z from "zod";
import { API_SCOPE_DESCRIPTIONS, API_SCOPES, type ApiScope } from "./scopes";
import { DEFAULT_LIMIT, MAX_LIMIT, MODEL_SORTS } from "./params";
import { apiSchemas } from "./schemas";
import { SOURCE_PLATFORMS } from "@/lib/sources/registry";

type Json = Record<string, unknown>;

const ref = (id: string) => ({ $ref: `#/components/schemas/${id}` });
const json = (schema: Json, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});
const errorResponse = (description: string) => json(ref("Error"), description);

const COMMON_ERRORS = {
  "401": { $ref: "#/components/responses/Unauthorized" },
  "403": { $ref: "#/components/responses/Forbidden" },
  "429": { $ref: "#/components/responses/RateLimited" },
};

const pathParam = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string", format: "uuid" },
});

const queryParam = (name: string, description: string, schema: Json = { type: "string" }) => ({
  name,
  in: "query",
  required: false,
  description,
  schema,
});

type Operation = {
  operationId: string;
  summary: string;
  description?: string;
  tag: string;
  scope: ApiScope | null;
  parameters?: Json[];
  requestBody?: Json;
  responses: Record<string, unknown>;
};

function operation(op: Operation) {
  return {
    operationId: op.operationId,
    summary: op.summary,
    description: [
      op.description,
      op.scope ? `Requires the \`${op.scope}\` scope.` : "Works with any valid key.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    tags: [op.tag],
    "x-required-scope": op.scope,
    ...(op.parameters ? { parameters: op.parameters } : {}),
    ...(op.requestBody ? { requestBody: op.requestBody } : {}),
    responses: { ...op.responses, ...COMMON_ERRORS },
  };
}

export const OPERATIONS: Record<string, Record<string, Operation>> = {
  "/me": {
    get: {
      operationId: "getMe",
      summary: "The key's user and scopes",
      tag: "Account",
      scope: null,
      responses: { "200": json(ref("Me")) },
    },
  },
  "/models": {
    get: {
      operationId: "listModels",
      summary: "List models",
      description:
        "Keyset-paginated. Filters combine with AND. Trashed models are never listed — a client mirroring the catalog with `updatedSince` won't see deletions.",
      tag: "Models",
      scope: "models:read",
      parameters: [
        queryParam("q", "Text match on title and description (typo-tolerant)"),
        queryParam("category", "Category id", { type: "string", format: "uuid" }),
        queryParam("tag", "Tag name; repeat for any-of", { type: "array", items: { type: "string" } }),
        queryParam("source", "Where the model came from", {
          type: "string",
          enum: [...SOURCE_PLATFORMS, "manual"],
        }),
        queryParam("owner", "A user id, or `me`"),
        queryParam("collection", "Only members of this collection", {
          type: "string",
          format: "uuid",
        }),
        queryParam("updatedSince", "Only models changed at or after this ISO 8601 time", {
          type: "string",
          format: "date-time",
        }),
        queryParam("sort", "Order", {
          type: "string",
          enum: [...MODEL_SORTS],
          default: "created_desc",
        }),
        queryParam("limit", "Page size", {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIMIT,
          default: DEFAULT_LIMIT,
        }),
        queryParam("cursor", "`nextCursor` from the previous page (same sort)"),
      ],
      responses: {
        "200": json(ref("ModelPage")),
        "400": errorResponse("Invalid filter"),
        "404": errorResponse("Unknown collection"),
      },
    },
    post: {
      operationId: "createModel",
      summary: "Create a model",
      description:
        "Attach files staged with `POST /uploads`. A model file matching one already in the catalog answers 409 unless `confirmDuplicate` is set — nothing is saved until then.",
      tag: "Models",
      scope: "models:write",
      requestBody: { required: true, content: { "application/json": { schema: ref("CreateModel") } } },
      responses: {
        "201": json(ref("Model"), "Created"),
        "400": errorResponse("Invalid body or upload handle"),
        "409": json(ref("DuplicateConflict"), "Possible duplicate"),
      },
    },
  },
  "/models/{id}": {
    get: {
      operationId: "getModel",
      summary: "Get a model with its files and BOM",
      tag: "Models",
      scope: "models:read",
      parameters: [pathParam("id", "Model id")],
      responses: { "200": json(ref("Model")), "404": errorResponse("No such model") },
    },
    patch: {
      operationId: "updateModel",
      summary: "Update a model",
      description:
        "Only the fields sent change; `tags` and `bom` replace the whole list. Recorded as a new version, so it can be reverted in the app.",
      tag: "Models",
      scope: "models:write",
      parameters: [pathParam("id", "Model id")],
      requestBody: { required: true, content: { "application/json": { schema: ref("UpdateModel") } } },
      responses: {
        "200": json(ref("Model")),
        "400": errorResponse("Invalid body or upload handle"),
        "404": errorResponse("No such model"),
        "409": json(ref("DuplicateConflict"), "Possible duplicate"),
      },
    },
    delete: {
      operationId: "trashModel",
      summary: "Move a model to the trash",
      description:
        "Restorable in the app for 30 days. Only the model's owner (or a moderator) may do this.",
      tag: "Models",
      scope: "models:write",
      parameters: [pathParam("id", "Model id")],
      responses: { "204": { description: "Trashed" }, "404": errorResponse("No such model") },
    },
  },
  "/uploads": {
    post: {
      operationId: "uploadFile",
      summary: "Stage a file",
      description:
        "The raw file bytes as the body. Returns an `upload` handle (valid 24 h, usable by this key's user only) to pass to `files[].upload`.",
      tag: "Files",
      scope: "files:write",
      parameters: [
        { ...queryParam("filename", "File name; its extension decides the kind"), required: true },
        queryParam("kind", "Optional; must match the extension", {
          type: "string",
          enum: ["model", "image", "pdf", "video"],
        }),
      ],
      requestBody: {
        required: true,
        content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
      },
      responses: { "201": json(ref("Upload"), "Staged"), "400": errorResponse("Bad file") },
    },
  },
  "/files/{id}": {
    get: {
      operationId: "downloadFile",
      summary: "Download a file",
      description: "Supports `Range` requests.",
      tag: "Files",
      scope: "files:read",
      parameters: [pathParam("id", "File id")],
      responses: {
        "200": {
          description: "The file",
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
        },
        "206": { description: "Partial content" },
        "404": errorResponse("No such file"),
      },
    },
  },
  "/categories": {
    get: {
      operationId: "listCategories",
      summary: "List categories",
      tag: "Catalog",
      scope: "models:read",
      responses: {
        "200": json({ type: "object", properties: { data: { type: "array", items: ref("Category") } } }),
      },
    },
  },
  "/tags": {
    get: {
      operationId: "listTags",
      summary: "List tags in use",
      tag: "Catalog",
      scope: "models:read",
      responses: {
        "200": json({ type: "object", properties: { data: { type: "array", items: ref("Tag") } } }),
      },
    },
  },
  "/collections": {
    get: {
      operationId: "listCollections",
      summary: "List collections",
      tag: "Collections",
      scope: "collections:read",
      parameters: [
        queryParam("limit", "Page size", { type: "integer", minimum: 1, maximum: MAX_LIMIT }),
        queryParam("cursor", "`nextCursor` from the previous page"),
      ],
      responses: { "200": json(ref("CollectionPage")), "400": errorResponse("Invalid cursor") },
    },
  },
  "/collections/{id}": {
    get: {
      operationId: "getCollection",
      summary: "Get a collection",
      description: "List its models with `GET /models?collection={id}`.",
      tag: "Collections",
      scope: "collections:read",
      parameters: [pathParam("id", "Collection id")],
      responses: { "200": json(ref("Collection")), "404": errorResponse("No such collection") },
    },
  },
  "/collections/{id}/models/{modelId}": {
    put: {
      operationId: "addModelToCollection",
      summary: "Add a model to a collection",
      tag: "Collections",
      scope: "collections:write",
      parameters: [pathParam("id", "Collection id"), pathParam("modelId", "Model id")],
      responses: {
        "204": { description: "Added (or already a member)" },
        "400": errorResponse("A smart collection"),
        "404": errorResponse("No such collection or model"),
      },
    },
    delete: {
      operationId: "removeModelFromCollection",
      summary: "Remove a model from a collection",
      tag: "Collections",
      scope: "collections:write",
      parameters: [pathParam("id", "Collection id"), pathParam("modelId", "Model id")],
      responses: {
        "204": { description: "Removed (or wasn't a member)" },
        "400": errorResponse("A smart collection"),
        "404": errorResponse("No such collection or model"),
      },
    },
  },
};

function componentSchemas(): Record<string, Json> {
  const { schemas } = z.toJSONSchema(apiSchemas, {
    io: "input",
    uri: (id) => `#/components/schemas/${id}`,
  }) as { schemas: Record<string, Json> };
  // Per-schema $schema/$id are noise inside an OpenAPI document.
  return Object.fromEntries(
    Object.entries(schemas).map(([id, schema]) => {
      const rest = { ...schema };
      delete rest.$schema;
      delete rest.$id;
      return [id, rest];
    }),
  );
}

export function buildOpenApiDocument(serverUrl: string) {
  const paths = Object.fromEntries(
    Object.entries(OPERATIONS).map(([path, ops]) => [
      path,
      Object.fromEntries(Object.entries(ops).map(([method, op]) => [method, operation(op)])),
    ]),
  );
  return {
    openapi: "3.1.0",
    info: {
      title: "Print Vault API",
      version: "1",
      description: [
        "The catalog's public REST API. Authenticate with a personal API key from Settings → API keys, sent as `Authorization: Bearer pv_…` (or `x-api-key`). A key acts as the user who created it, limited to its scopes:",
        ...API_SCOPES.map((s) => `- \`${s}\` — ${API_SCOPE_DESCRIPTIONS[s]}`),
        "A write scope implies read on the same resource. Errors are `{ error, code }` with a matching status.",
      ].join("\n"),
    },
    servers: [{ url: serverUrl }],
    security: [{ bearerKey: [] }, { headerKey: [] }],
    tags: ["Account", "Models", "Files", "Catalog", "Collections"].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerKey: { type: "http", scheme: "bearer", description: "A pv_… API key" },
        headerKey: { type: "apiKey", in: "header", name: "x-api-key" },
      },
      responses: {
        Unauthorized: errorResponse("Missing, invalid, expired or revoked key"),
        Forbidden: errorResponse("The key lacks the scope, or the action is owner-only"),
        RateLimited: errorResponse("Too many requests for this key; see Retry-After"),
      },
      schemas: componentSchemas(),
    },
  };
}
