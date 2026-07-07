<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Testing

Unit tests run on Node's built-in test runner (`node:test` + `node:assert/strict`)
via `tsx` — there is no Vitest/Jest. Run the whole suite with `npm test`, which
covers `src/**/*.test.ts` plus the slicer service's `slicer/*.test.mjs`.

## What the suite is for

This is a young, fast-moving project where most changes land through AI agents.
The suite exists to answer one question: **"did this change break a behaviour
that already worked?"** — and to double as executable documentation of the
tricky, non-obvious contracts (Onshape's meters-not-mm exports, Bambu's
double-escaped HTML, AMS extruder selection, the ZIP-tail ranged reads). Aim
for tests an agent can read to *learn the contract*, not tests that pin down an
implementation.

Write tests that:

- **Assert on observable behaviour**, not internal structure. Check the parsed
  result, the translated config, the round-tripped CSV — not which private
  helper ran or how many times. A refactor that preserves behaviour should keep
  the tests green; that's the whole point.
- **Cover the contract's edges**, since those are where regressions hide and
  where the documentation value is highest: the fallback branch, the hostile
  input that must be rejected, the multi-plate sum, the look-alike host. One
  crisp test per real behaviour beats ten that restate the same path.
- **Name the behaviour and its "why."** The test title and a one-line comment
  should tell an agent *why* the case exists ("percent is allowed only for
  fill_density", "objects on extruder 2 → second filament"), so a future change
  that trips it knows whether it broke something or changed a documented rule.

Avoid: snapshotting large blobs, asserting exact error strings (assert that it
*errored*, or match a stable substring), re-testing a third-party library's
behaviour, and duplicating one function's cases across several files.

## Conventions

- Co-locate tests next to the code as `*.test.ts` (e.g. `src/lib/format.ts` →
  `src/lib/format.test.ts`). Slicer-service tests are `*.test.mjs` next to
  `slicer/server.mjs`.
- Import from source with the `@/` alias; `tsx` resolves it from `tsconfig.json`.
- Prefer **pure logic** (URL parsers, formatters, BOM/CSV, crypto round-trips,
  the ZIP/config parsers). Do not import modules with load-time side effects
  into a test — e.g. `@/lib/s3` builds an S3 client from env, `@/db` opens a
  pool. Extract the pure core and test that: `threemf-slice-info.ts` holds the
  parsing (unit-tested) while `threemf-remote.ts` only wires it to S3, and the
  slicer's `lib.mjs` holds the parsing/translation while `server.mjs` does I/O.
  Follow that split when a new feature mixes logic with a client.
- No DB or network in unit tests. If a function needs bytes, build them in
  memory (fflate's `zipSync` makes a `.3mf`/ZIP fixture) or inject the reader
  (see `RangeReader` in `threemf-slice-info.ts`); stub `fetch` for HTTP paths.
  The full import/estimate HTTP flows and DB actions stay manual/integration —
  use the `/verify` or `/run` skills to exercise them against a running app.

Example:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "@/lib/format";

test("formatDuration splits hours and minutes", () => {
  assert.equal(formatDuration(5460), "1 h 31 min");
});
```

# Architecture notes

Decisions taken and why — guidance for development, not user docs.

- **Uploads** stream through `POST /api/upload` to S3 (no browser↔S3 CORS setup needed);
  only signed-in users can upload, and file extensions are validated server-side.
- **Downloads & images** stream from S3 through `GET /api/files/[id]`, so the S3
  endpoint never needs to be reachable from the browser.
- **Auth** is BetterAuth email/password with sessions stored in Postgres.
- **.3mf import** (`src/lib/threemf.ts`) runs client-side on file selection: the zip is
  unpacked in the browser (fflate) and title/description (`3D/3dmodel.model`), printer
  name (`Metadata/project_settings.config` / `slice_info.config`) and preview images
  (`Auxiliaries/`, `Metadata/plate_*.png`, thumbnails) prefill the form.
- **URL import** (`POST /api/import`, `src/lib/import/`) fetches a model's public
  metadata + images server-side and stages them to S3 for the create form.
  MakerWorld uses the anonymous `api.bambulab.com/v1/design-service/design/{id}`
  JSON API (the makerworld.com pages themselves are Cloudflare-gated); Printables
  uses its public GraphQL API, which also yields anonymous file download links.
  MakerWorld file downloads require a Bambu Cloud login: a user connects their
  account at **Settings → Bambu Cloud** (`src/app/settings/bambu/`, backed by
  `src/lib/bambu/`), which logs in via `api.bambulab.com` (handling email-code
  and TOTP two-factor) or accepts a pasted `token` cookie. The resulting access
  token is stored **encrypted at rest** (AES-256-GCM, `src/lib/crypto.ts`, keyed
  by `BAMBU_TOKEN_SECRET`/`BETTER_AUTH_SECRET`). At import time the token
  exchanges each print profile for a short-lived presigned URL that streams to
  S3 like any other asset. Without a connection, only metadata + images import.
- **Onshape auth & import flow** (`src/lib/onshape/`, `src/lib/import/onshape.ts`)
  authenticates with OAuth2 ("Sign in with Onshape", the flow behind
  [passport-onshape](https://github.com/onshape/passport-onshape), implemented
  directly in `src/lib/onshape/oauth.ts`): the self-hoster registers one OAuth
  app at dev-portal.onshape.com (redirect URL
  `{BETTER_AUTH_URL}/api/onshape/callback`, read documents + profile scopes)
  and sets `ONSHAPE_CLIENT_ID`/`ONSHAPE_CLIENT_SECRET`; users then connect
  under **Settings → Onshape** via consent screen — no API keys to copy.
  Access + refresh tokens are stored encrypted at rest like the Bambu token,
  access tokens are refreshed transparently (~60 min lifetime, rotated refresh
  tokens), and a connection that can no longer be refreshed is dropped so the
  user simply reconnects. Importing a `cad.onshape.com/documents/…` URL reads
  the document metadata + thumbnail and runs an asynchronous 3MF export of the
  linked tab (or of every Part Studio/Assembly tab) — see the Onshape
  integration section below for the API details. The resulting `.3mf` files
  stream to S3 like any other asset and get slice estimates like regular
  uploads. The canonical document URL is stored as the model's `sourceUrl`
  (doubling as the "Edit in Onshape" link) together with the workspace
  microversion; "Sync from Onshape" (owner-only,
  `POST /api/models/{id}/onshape-sync`) compares the current microversion and
  re-exports, replacing the previously imported files (tracked via
  `model_files.onshape_element_id`).
- **Print estimates** come from two sources. Files sliced in Bambu Studio /
  OrcaSlicer embed per-plate predictions in `Metadata/slice_info.config`, which
  are read directly from S3 via ranged GETs (`src/lib/threemf-remote.ts`).
  Unsliced `.3mf` files are sent to the **slicer service** (`slicer/`, the
  third compose container): a zero-dependency Node HTTP wrapper around the
  headless PrusaSlicer CLI (Debian's `prusa-slicer` package) that parses print
  time and filament use from the G-code footer. The service honors the
  settings embedded in the file — Bambu/Orca `project_settings.config` keys
  are translated to their PrusaSlicer equivalents (machine limits, speeds,
  accelerations, layer height, infill, and the filament of the extruder the
  objects actually use), PrusaSlicer projects load their own `Slic3r_PE.config`
  — falling back to a generic 0.4 mm/PLA profile (`slicer/config.ini`) for
  files without settings. Only whitelisted keys are copied (a crafted archive
  can't smuggle in `post_process` scripts), and the bed is a huge virtual
  plate so multi-plate Bambu projects (whose world coordinates extend far past
  the physical bed) still slice; estimates are totals across all plates.
  Slicing runs in the background after upload (`after()` in the model actions,
  `src/lib/slicer.ts`); results land on `model_files` (`slice_status`,
  `print_time_seconds`, `filament_grams`, …) together with the hardware the
  project was set up for (`printer_info`: printer model, nozzle, build plate,
  used filaments), which the model page shows per file. Slicer-derived numbers
  are still approximations (PrusaSlicer's time estimator, not the printer's
  firmware) and shown with a `~` prefix; files PrusaSlicer cannot slice are
  flagged on the model page so the uploader notices a broken or unprintable
  file. Legacy `.step` files (from before Onshape imports switched to 3MF) and
  files uploaded before this feature are skipped. The service is optional:
  without `SLICER_URL`, unsliced files simply show no estimates and stay
  `pending`.
- **Search** is a dedicated `/search` page backed entirely by Postgres (no
  separate search engine — kept simple and self-hostable). `src/lib/search.ts`
  runs one keyset-paginated query over a `models UNION ALL collections`
  projection: fuzzy matching uses `pg_trgm`'s `strict_word_similarity` (best
  word-boundary-aligned match, so a short query like "tlon" matches the word
  "Talon" inside a longer title — whole-string `similarity()`/`%` scores even an
  exact word below the 0.3 default and was the original bug) OR'd with an ILIKE
  substring fallback, and relevance ranks on the same word similarity. Models
  match on title, description, and their tags (an `EXISTS` over model_tags);
  collections match on title + description only. The GIN trigram indexes still
  accelerate the ILIKE fallback. Filters — type (models/collections), uploader,
  printer, filament (jsonb `@>`), nozzle, and print-time bucket — apply to the
  model_files metadata via `EXISTS`; any model-only filter drops collections
  from the union. Sort is relevance (falls back to newest without a query),
  newest, or oldest, each with its own self-describing keyset cursor
  (score-based or time-based). All URL/param parsing and the cursor codec live
  in the DB-free `src/lib/search-params.ts` (unit-tested); `pg_trgm` and the
  supporting indexes are created in migration `0008_search.sql`. The homepage
  is now a pure browse grid (category filter + recent collections/models); its
  search box just submits the query to `/search`.

# Onshape integration

Code lives in `src/lib/onshape/` (API client, OAuth, credentials) and
`src/lib/import/onshape.ts` (importer); the sync endpoint is
`src/app/api/models/[id]/onshape-sync/route.ts`. Things to know before
touching it:

- **Auth**: every call needs the user's OAuth2 Bearer token (no anonymous
  API). Invalid tokens don't always 401 — `/users/sessioninfo` answers 204 as
  an anonymous session, so only a 200 counts as authenticated.
- **Exports are async translations**: start one, poll
  `GET /translations/{id}` until `requestState` leaves `ACTIVE`, then download
  from `GET /documents/d/{did}/externaldata/{fid}` using
  `resultExternalDataIds`. Poll with backoff (Onshape rate-limits).
- **Format-specific export routes exist only for glTF, OBJ, and STEP**
  (`POST …/export/step` etc.). Every other format — including the 3MF we
  export — must go through the generic
  `POST /{partstudios|assemblies}/d/{did}/{wv}/{wvid}/e/{eid}/translations`
  with `formatName` in the body. Hitting a nonexistent route like
  `…/export/3mf` returns 404, which `onshapeFetch` surfaces as the misleading
  "Document not found" error. See `buildExportRequest` in
  `src/lib/onshape/api.ts` and
  <https://onshape-public.github.io/docs/api-adv/translation/>.
- **Mesh formats need tessellation detail parameters**: translations to mesh
  formats (3MF, STL, …) must include a `resolution` preset
  (`fine|medium|coarse`, lowercase) — or custom `angularTolerance` /
  `distanceTolerance` / `maximumChordLength` values — plus the `unit`, or the
  translation starts fine but then FAILs with "Invalid 3MF detail parameters
  were specified". CAD formats like STEP don't take these. The full request
  schema is `BTTranslateFormatParams` in `cad.onshape.com/api/openapi`.
- **We export 3MF only** so the headless slicer can slice the result; the
  legacy STEP export path was removed on purpose — don't reintroduce it.
- **Onshape 3MF exports are in meters, centered on the origin** — the `unit`
  request parameter does not change the written file (`unit="meter"` with
  meter-scale coordinates). That is spec-valid 3MF, but PrusaSlicer, Bambu
  Studio and OrcaSlicer ignore the 3MF `unit` attribute (coordinates are read
  as mm → a 25 mm part becomes 0.025 mm) and reject geometry at negative X/Y
  as "outside of the print volume". Every staged Onshape export therefore runs
  through `normalizeThreeMf` (`src/lib/threemf-normalize.ts`), which rescales
  the model to millimeters and moves the build onto the plate (XY center at
  128 mm, lowest point at z=0) — keep that in place for any new code path that
  stores Onshape exports.
- **Part Studios vs Assemblies** use different URL resources (`partstudios` /
  `assemblies`) but the same request shape; pick by `elementType`.
- **URL pins**: document URLs are
  `…/documents/{did}/{w|v|m}/{wvmid}[/e/{eid}]` — `w` workspaces are syncable,
  `v` versions are immutable snapshots, `m` microversions are rejected at
  import (not exportable via the w/v endpoints).
- Don't trust remembered endpoint shapes; verify against
  `cad.onshape.com/api/openapi` or the docs below before changing API calls.

# Documentation Sources

- [Onshape API](https://onshape-public.github.io/docs/api-intro/)
- [Onshape import/export (translations)](https://onshape-public.github.io/docs/api-adv/translation/)