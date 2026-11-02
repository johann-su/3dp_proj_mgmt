# Public REST API (/api/v1)

*Read before touching `/api/v1`, API keys, or the shared mutation core.
Update in the same PR that changes this behaviour.*

The first step of the plugin roadmap: a stable, versioned API so integrations
(n8n, Home Assistant, CAD add-ins, a browser-extension importer, later
plugins) can work with the catalog without a session cookie and without
reaching into the database. The operator-facing contract is
[`docs/api-reference.mdx`](../api-reference.mdx#rest-api-v1); this file
holds the decisions behind it.

## Layout

| Piece | Where | Pure? |
|---|---|---|
| Scopes, key prefix, header parsing | `src/lib/api/scopes.ts` | yes |
| Request/response schemas (zod) | `src/lib/api/schemas.ts` | yes |
| Query params, keyset cursors | `src/lib/api/params.ts` | yes |
| Body → mutation-core input (PATCH merge) | `src/lib/api/model-input.ts` | yes |
| Rows → response shapes | `src/lib/api/serialize.ts` | yes |
| Status/error mapping | `src/lib/api/http.ts` | yes |
| Signed upload handles | `src/lib/api/upload-token.ts` | yes (key injected) |
| OpenAPI document | `src/lib/api/openapi.ts` | yes |
| Auth + scope + error wrapper | `src/lib/api/route.ts` | no |
| Read queries | `src/lib/api/queries.ts` | no |
| Key listing/revocation | `src/lib/api/keys.ts` | no |
| Routes | `src/app/api/v1/**/route.ts` | — |
| Settings → API keys | `src/app/settings/api-keys/` | — |

**Writes go through the app's own mutation core**:
`src/lib/model-mutations.ts` (create/update/trash/restore/purge/revert/like)
and `src/lib/collection-mutations.ts` (membership). The server actions are thin
wrappers over the same functions, so validation, duplicate flagging, slicing,
revalidation and the versioning invariants
([versioning.md](./versioning.md)) are identical on both paths. Don't add an
API write that bypasses them — add the mutation there and call it from both.

## Off by default

`ENABLE_API=true` gates the api-key plugin, every `/api/v1` route (404
otherwise, including `openapi.json`) and Settings → API keys. Unlike MCP it
opens no unauthenticated write surface, but a key is a long-lived bearer
credential that bypasses SSO and its MFA, which an operator relying on
`DISABLE_PASSWORD_LOGIN` may not want.

## Keys: `@better-auth/api-key`, with our own scope check

- **Never a session.** `enableSessionForAPIKeys: false`: a key must not open
  cookie-guarded pages and server actions, only `/api/v1` with its scopes.
- **Scopes are the plugin's "permissions"**, stored as `{ resource: actions[] }`
  JSON; `scopes.ts` is the only place that translates to the `models:write`
  spelling the API and docs use. Unknown permissions are dropped on read, so a
  key can't gain a scope we don't enforce. **Write implies read on the same
  resource** (`hasScope`) — every write answers with what it changed.
- **We check scopes ourselves** after `verifyApiKey({ key })` instead of
  passing `permissions` to it: the plugin reports a missing permission as
  `KEY_NOT_FOUND`, which would turn every 403 into a 401.
- **`permissions` is server-only.** The plugin rejects it on client requests,
  so keys are created by the Settings server action calling
  `auth.api.createApiKey({ body: { userId, permissions, … } })` *without*
  request headers (that is what makes it a server call). A key created
  straight through `POST /api/auth/api-key/create` carries no permissions and
  gets 403 on everything but `GET /me` — harmless, verified.
- **The plugin's default rate limit is 10 requests per *day*.** Configured to
  600/minute in `src/lib/auth.ts`; the `apikey` columns default to the same.
  Exceeding it answers 429 with `Retry-After` (the plugin's `RATE_LIMITED`).
- **`apikey.reference_id` gets a cascading FK** in our migration (the plugin
  declares it a plain string): deleting a user must kill their keys.
  `route.ts` also re-reads the user row on every request (for the role
  owner-gated mutations check) and refuses a key whose user is gone.
- Only the key's hash is stored; `start` (prefix + 3 chars) identifies it in
  Settings. Keys are `pv_…` so leaked ones are recognisable, and
  `apiKeyFromHeaders` only takes a Bearer token with that prefix — an MCP JWT
  sent here by mistake is "no key", not a hashed DB lookup.

## Uploads are signed handles

`POST /uploads` stages bytes like `/api/upload` and returns an `upload`
handle: an HMAC over `{ key, filename, size, kind, contentHash, userId, exp }`
(`upload-token.ts`, 24 h). The browser flow echoes the staged descriptor back
through the client; the API doesn't, so a client can't lie about size or
content hash (which drives duplicate detection) or attach another user's
staged upload. The kind follows from the extension (`fileKindForFilename` —
the allowlists don't overlap); a `?kind=` that disagrees is rejected.

## Reads

- **Filtering reuses the smart-collection rule compiler** like the MCP search,
  so the API filters as saved searches do. Every listing filters
  `deleted_at IS NULL`; trashed models and their files answer 404.
- **Keyset cursors carry Postgres' own timestamp text** (`to_char(…, 'US')`),
  not a JS Date: a Date rounds to milliseconds, and rows created within the
  same millisecond as a page boundary would be skipped. Cursors record their
  sort and are rejected under another one.
- `GET /models?collection=` evaluates a smart collection's rules live
  (`collectionMembershipSql`), the same as the app.
- `updatedSince` can't report deletions — that is what webhooks (next roadmap
  step) are for.
- `GET /files/{id}` is `files:read`, separate from metadata, because model
  files can be paid content; served `private, no-store`, ranges supported.

## Writes

- **PATCH merges into the current state** (`updateInputFromPatch`): the core's
  update takes full lists (tags, BOM, videos), so every field a PATCH omits is
  filled from the model as it is. `categoryId: null` is a value ("Other");
  only an absent key keeps it. Videos aren't API-editable yet but are passed
  through, so a PATCH can't drop them.
- Bodies are `.strict()` — a typo'd field is a 400, not a silently ignored
  no-op.
- The duplicate prompt becomes **409 `duplicate`** with the matches; repeating
  with `confirmDuplicate: true` saves and records the flag, like the browser.

## The OpenAPI document

`openapi.ts` renders the zod registry in `schemas.ts` (input mode, so
defaulted request fields aren't `required`) plus a hand-written path table
naming each operation's scope (`x-required-scope`). `openapi.test.ts` fails
when the table and the route files drift apart — paths *and* exported
methods — or when a `$ref` dangles.

## Adding an endpoint

1. Shapes in `schemas.ts` (register response schemas in `apiSchemas`).
2. The route via `apiRoute(scope, …)`; writes through the mutation core.
3. An entry in `OPERATIONS` (`openapi.ts`) — the parity test enforces it.
4. Unit tests for any new pure logic; the row in the endpoints table in
   `docs/api-reference.mdx`.

Not covered yet, deliberately: trash restore, version history, collection
create/edit, the customizer, URL import, and event delivery (webhooks/SSE) —
see the roadmap in the PR that introduced this.

## Verifying a change

Unit tests cover scopes, handles, params, the PATCH merge, serialization and
the document. The rest needs a running app (`verify` skill) with
`ENABLE_API=true` (and `STORAGE_BACKEND=filesystem` to keep test uploads off
real S3): create keys through the Settings action (its id comes from the
served client chunks), then drive `/api/v1` with curl.
