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

Decisions taken and why — guidance for development.

- **The whole catalog is private** — instances hold paid models. Two layers:
  `src/proxy.ts` (Next 16's renamed middleware) redirects pages without a
  session *cookie* to `/sign-in`, but that's an optimistic presence check a
  hand-set cookie defeats and its matcher skips `/api` — so every page also
  verifies the session server-side (`getSession()` + redirect), and every API
  route and server action checks it too (list-type actions return an empty
  page instead). Keep both checks when adding a page. There is no
  finer-grained RBAC on purpose: signed in = full read access, and **editing
  is collaborative — any signed-in user can edit a model or collection**
  (update fields/files, generate customizer variants, run Onshape/MakerWorld
  sync, add/remove collection members), since a self-hosted instance serves a
  trusted group and shared editing is worth more than the risk. **Destructive/
  owner-scoped actions stay owner-only**: deleting a model (`deleteModel`) or
  collection (`deleteCollection`); deleting a generated variant is owner-or-
  its-generator. When adding a mutation, follow this split — open editing to
  any session, gate only deletion/ownership transfer on
  `record.userId === session.user.id`.
- **Uploads** stream through `POST /api/upload` to S3 (no browser↔S3 CORS setup needed);
  only signed-in users can upload, and file extensions are validated server-side.
  Stored content types are always derived from the allowlisted extension
  (`contentTypeForFilename`), never from a client header/value — `/api/files`
  serves images inline on our origin, so an uploader-chosen `text/html` would
  be stored XSS. File routes also send `X-Content-Type-Options: nosniff`.
- **Downloads & images** stream from S3 through `GET /api/files/[id]`, so the S3
  endpoint never needs to be reachable from the browser. The route accepts a
  session cookie (browser links/downloads) **or a signed file token**
  (`src/lib/file-token.ts`: HMAC over file id + expiry, keyed off
  `BETTER_AUTH_SECRET`, expiry bucketed to week boundaries so URLs stay
  cache-stable). Tokens exist because two consumers cannot send cookies: the
  next/image optimizer (its internal fetch carries no request headers) and
  slicer deep links. Images therefore render from `fileSrc(id)`
  (`…?token=…`) — signed server-side and passed down in the card/gallery
  data, since cards also render inside client components — and deep links use
  the token **path** variant `/api/files/[id]/[token]/[filename]` (Orca keeps
  the query string when naming downloads, so `?token=` would corrupt the
  filename). `next.config.ts` must keep `images.localPatterns` allowing
  `/api/files/**` with unrestricted `search`, or Next 16 rejects the tokened
  srcs.
- **Auth** is BetterAuth email/password with sessions stored in Postgres.
  `DISABLE_SIGNUP=true` turns off self-registration (BetterAuth's
  `emailAndPassword.disableSignUp` plus hiding the `/sign-up` page); OIDC
  keeps provisioning users on first login regardless — who may authenticate
  through SSO is the IdP's decision.
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
- **MakerWorld collection import** (`POST /api/import/collection`,
  `src/lib/import/makerworld-collection.ts` + `collection-job.ts`) bulk-imports
  every model of a `makerworld.com/…/collections/{id}` list. Collections are
  "favorites lists" in Bambu's API: `GET
  api.bambulab.com/v1/design-service/favorites/{id}` (metadata) and
  `…/favorites/{id}/designs?limit=&offset=` (contents, hidden designs
  excluded) answer anonymously — undocumented; discovered from MakerWorld's
  own frontend (`getFavorites` in the `/collections/[collectionId]` page
  chunk), so Bambu can change them at will. Because editing dozens of models
  by hand is infeasible, imported designs skip the create-form draft flow:
  the job runs in the background (`after()`, like slicing) via an
  `import_jobs` row (status/progress/heartbeat), reuses the single-model
  importer per design, inserts finished models directly, and links them into
  a local collection created up front — already-imported designs (matching
  `sourceUrl`) are only linked, which makes re-running a failed job a resume.
  The source URL is stored on the collection (`collections.source_url`,
  rendered as an "Imported from MakerWorld" link), and "Sync from MakerWorld"
  (owner-only, `POST /api/collections/{id}/sync`) re-runs the same job
  against the existing collection: designs added remotely import as new
  models, everything already in the library is (re-)linked. Sync never
  deletes — models removed remotely stay, and a model the user pulled out of
  the local collection gets re-linked on the next sync. Local
  title/description edits are never overwritten.
  Slice estimates run as a post-phase so a slow slicer doesn't stall visible
  progress. A connected Bambu account is required up front (otherwise every
  model would be a file-less shell), jobs are capped at 200 designs, and one
  runs per user at a time. Progress surfaces as a ring in the top-right
  header (`src/components/import-progress.tsx`) polling `GET
  /api/import-jobs`, with cancel (checked between designs) and per-design
  failures as warnings; a poll marks heartbeat-stale "running" jobs failed so
  a server restart doesn't leave a spinner forever.
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
- **Parametric OpenSCAD models**: a model can carry its `.scad` source as a
  model file (uploaded, or imported — Printables serves `.scad` anonymously
  via its `otherFiles` group; MakerWorld's comes through `GET
  api.bambulab.com/v1/design-service/design/{id}/model?modelType=all&type=download`,
  undocumented and Bambu-login-gated like profile downloads; only
  `modelType=all` exists ("scad"/"3mf" answer 404) and it returns one zip of
  every raw file, from which staging extracts just the `.scad` entries). The
  owner gets a "Customize" button on the model page linking to a full-page
  customizer (`/models/{id}/customize/{fileId}`): a parameter rail built
  from the OpenSCAD customizer comments in the source — parsed by the pure
  `src/lib/scad-params.ts` (the design API's `scadConfig` field is empty in
  practice, so the source is the only schema; `/* [Hidden] */` stays hidden,
  unrecognized annotations degrade to plain inputs) — beside a live three.js
  preview (plain `three`, no react-three-fiber; renders on demand, no rAF
  loop) fed by `POST /api/models/{id}/customize/preview`, which returns
  ephemeral **binary STL** (the service's second output format; nothing is
  stored, the client debounces changes and drops stale responses via a
  sequence counter). "Generate .3mf" (owner-only, `POST
  /api/models/{id}/customize`) renders through the **openscad service**
  (`openscad/`, fourth compose container: zero-dependency wrapper around the
  OpenSCAD CLI, Debian package + vendored pinned BOSL2/MCAD under
  `OPENSCADPATH`) and **stores** the result as a `model_files` row flagged
  `generated_from_id` + `generated_params` — stored rather than streamed back
  because only stored files get slice estimates and slicer deep links.
  Identical parameter sets dedupe via `generated_params_hash`; variants are
  capped at 20 per source, render nested under the `.scad` card, and are
  deletable (DELETE on the same route). Renders are normalized by
  `normalizeThreeMf` (OpenSCAD centers on the origin like Onshape).
  Security: values only travel via OpenSCAD's `-p` parameter-set JSON (never
  `-D`/CLI), `coerceScadValues` clamps them against the parsed schema, and
  `findForbiddenFileRefs` rejects `import()`/`surface()` and any
  `include`/`use` outside the bundled libraries (multi-file projects are
  unsupported — keep `SCAD_LIBRARY_ALLOWLIST` in sync with the Dockerfile).
  The service itself runs non-root with a hard timeout and compose
  memory/pid limits (CGAL happily eats unbounded RAM). Optional like the
  slicer: without `OPENSCAD_URL` the customizer UI is hidden and `.scad`
  files are plain downloads. Slicer deep links are `.3mf`-only — Bambu
  Studio rejects other filenames, so `.scad`/`.step` rows render a plain
  download button instead of `FileDownloadMenu`.
- **Categories are a fixed, keyword-tagged set** — the seeded list
  (`src/lib/category-defaults.ts`) is the whole taxonomy; imports never add
  categories (that would sprawl into duplicates). Each category carries
  `keywords` matched by the pure `src/lib/category-suggest.ts` against a
  model's title, tags and — strongest signal — the source platform's own
  category names (MakerWorld's `categories` list leaf-first, Printables'
  `category.path`; both flow through `ImportedProject.categories` into the
  create-form draft). The keyword lists embed the MakerWorld taxonomy mapped
  onto ours, so source categories rank existing ones instead of creating new
  ones. No model stays uncategorized: the form preselects the live suggestion
  (fallback "Other") until the user picks manually, the collection-import job
  assigns one on direct insert (`pickCategoryId` in `src/lib/categories.ts`),
  the server actions fall back to "Other" on null, and migration 0015
  backfilled existing blanks. "Other" has no keywords on purpose — it is only
  ever the fallback. Keyword defaults live in both `category-defaults.ts` and
  migration `0015_category_keywords.sql`; keep them in sync.
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
  newest, oldest, most viewed, or most downloaded, each with its own
  self-describing keyset cursor (score/time/metric-based). "Most downloaded"
  sums `model_files.download_count` per model — collections have no download
  metric to sum, so it's model-only like the printer/filament/nozzle filters
  and degrades to newest for a collections-only search. Views/downloads are
  fire-and-forget counters (`src/lib/metrics.ts`: `models`/`collections`
  `view_count` bumped on page load, `model_files.download_count` on file
  download). All URL/param parsing and the cursor codec live in the DB-free
  `src/lib/search-params.ts` (unit-tested); `pg_trgm` and the supporting
  indexes are created in migration `0008_search.sql`. The homepage
  (`src/lib/list-queries.ts`) is the same kind of ranked `models UNION ALL
  collections` listing — category filter plus a sort control (newest, oldest,
  recently updated, most viewed, most downloaded) — and shares its
  id-hydration step with search via `src/lib/catalog-hydrate.ts`; its own pure
  sort/cursor parsing lives in `src/lib/feed-params.ts`. Its search box just
  submits the query to `/search`.
- **"Open in slicer" deep links** (`src/app/models/[id]/file-download-menu.tsx`)
  hand a `.3mf` to Bambu Studio / OrcaSlicer via their custom URL schemes. The
  two apps register different schemes **and parse the link differently**, so the
  component builds a *different* URL per app (`SLICERS[].buildUrl`). Both apps
  fetch the URL themselves **without cookies**, so deep links use the
  token-authenticated path route `/api/files/<id>/<token>/<name>.3mf`
  (`src/app/api/files/[id]/[token]/[filename]/`, reusing the `[id]` handler;
  the token must be a path segment, not `?token=`, because Orca keeps the
  query string when deriving the filename). Do not try
  to unify the two link formats — every "obvious" shared format breaks one of them:
  - **Schemes differ from the app names.** OrcaSlicer registers `orcaslicer:`;
    Bambu Studio registers **`bambustudioopen:`** (NOT `bambustudio:`). An
    unregistered scheme fails *silently* — macOS finds no handler and shows
    nothing, not even the "open this app?" prompt. Verify against the installed
    app: `PlistBuddy -c "Print :CFBundleURLTypes"
    /Applications/BambuStudio.app/Contents/Info.plist`.
  - **Orca** wants `orcaslicer://open?file=<encoded-url>` (Orca's regex
    `open[\/]?\?file=` also accepts a `open/?` slash — the legacy PrusaSlicer
    "mysterious slash" — but Printables/MakerWorld omit it, so we do too) and
    (for a non-MakerWorld host) treats the *entire* remainder after `file=` as
    the URL to fetch — so **must NOT** get a `&name=` appended (it gets fetched
    as part of the URL and our route 404s: `{"error":"Not found"}`). Orca names
    the saved file from that URL's **last path segment** (`filename_from_url` in
    `Downloader.cpp` — which does **not** strip query strings), so a bare
    `.../api/files/<id>` saves as the UUID with no extension and a `?token=`
    would end up inside the filename. We therefore point Orca at the
    token+filename-suffixed route `.../api/files/<id>/<token>/<name>.3mf`
    (which ignores the name and reuses the `[id]` handler) to get a real `.3mf`
    name — the same shape as Printables' `…/build_tray_v3.step` link. See
    `Downloader::start_download` in OrcaSlicer.
  - **Bambu** (macOS `GUI_App::MacOpenURL`) takes whatever follows
    `bambustudioopen://`, `url_decode`s it once, and treats it as the raw
    download URL — **rejected unless it starts with `http`/`https`** (an
    `open/?file=` prefix silently no-ops *after* the trusted-site prompt). It
    then splits a trailing `&name=` (a literal `.Find("&name=")`, so it must be
    `&name=`, not `?name=`) to name the file and **aborts ("Download failed,
    unknown file format") unless that name ends in `.3mf`** (the bare-UUID URL
    tail has no extension). Match MakerWorld's own links: percent-encode the
    whole `<url>&name=<filename>.3mf` as one blob after the scheme
    (`bambustudioopen://<encodeURIComponent(url + "&name=" + name)>`) so the
    browser can't mangle the literal `&`/`:` before the OS hands it off.
  - Cold launch (app not already running): **Bambu works** — `MacOpenURL`
    stashes the URL in `m_download_file_url` and replays it after `post_init`.
    **Orca does not** — its Apple Event arrives before the handler is ready and
    is dropped, so it only launches to the home screen (upstream macOS bug, not
    fixable here). Bambu's `import_model_id` also early-returns if its network
    plugin/agent isn't loaded (`if (!m_agent) return;`), and its trusted-site
    allowlist only auto-trusts makerworld / bblmw CDN / `amazonaws.com` /
    `aliyuncs.com` hosts (any other host — including a self-hosted instance —
    prompts "not from a trusted site"; clicking through is expected).

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
- Slicer deep links — [Bambu Studio `GUI_App.cpp` URL handler](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/GUI_App.cpp)
  and `Plater::import_model_id` in [`Plater.cpp`](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/Plater.cpp);
  OrcaSlicer's identical [`Plater::import_model_id`](https://github.com/SoftFever/OrcaSlicer/blob/main/src/slic3r/GUI/Plater.cpp);
  [Bambu Studio URL schemes — what doesn't work and why](https://productionshaped.com/notes/2026-05-14-bambu-studio-url-schemes-what-doesnt-work-and-why/);
  [BambuStudio #6120 (URL handler domain restriction)](https://github.com/bambulab/BambuStudio/issues/6120)