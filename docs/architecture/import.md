# Platform import (.3mf, MakerWorld/Printables, source sync, collections)

*Read before touching the importers, source sync, or collection import. Onshape
has its own file — see [`onshape.md`](./onshape.md). Update in the same PR that
changes this behaviour.*

## .3mf import

`src/lib/threemf.ts` runs client-side on file selection: the zip is unpacked in
the browser (fflate) and title/description (`3D/3dmodel.model`), printer name
(`Metadata/project_settings.config` / `slice_info.config`) and preview images
(`Auxiliaries/`, `Metadata/plate_*.png`, thumbnails) prefill the form.

## URL import

`POST /api/import`, `src/lib/import/`: fetches a model's public metadata +
images server-side and stages them to S3 for the create form. MakerWorld uses
the anonymous `api.bambulab.com/v1/design-service/design/{id}` JSON API (the
makerworld.com pages themselves are Cloudflare-gated); Printables uses its
public GraphQL API, which also yields anonymous file download links. MakerWorld
file downloads require a Bambu Cloud login: a user connects their account at
**Settings → Bambu Cloud** (`src/app/settings/bambu/`, backed by
`src/lib/bambu/`), which logs in via `api.bambulab.com` (handling email-code and
TOTP two-factor) or accepts a pasted `token` cookie. The resulting access token
is stored **encrypted at rest** (AES-256-GCM, `src/lib/crypto.ts`, keyed by
`BAMBU_TOKEN_SECRET`/`BETTER_AUTH_SECRET`). At import time the token exchanges
each print profile for a short-lived presigned URL that streams to S3 like any
other asset. Without a connection, only metadata + images import.

**Per-file import provenance**: every file staged by an importer (all three
platforms, single-model and collection jobs, Onshape sync inserts) is flagged
`model_files.imported`, so files added manually to an imported model later stay
distinguishable — the model page and edit form badge imported files with a
cloud icon. The flag is carried through version snapshots and scopes the source
sync below; Onshape sync keeps selecting the files it replaces via
`onshape_element_id`, never via `imported`. Migration 0019 backfilled it
(Onshape by element id; other platforms by files sharing their model's
`created_at` — same insert transaction — on models with a `source_url`).

## Source sync (MakerWorld/Printables)

`POST /api/models/{id}/source-sync`, pure planner in
`src/lib/import/sync-diff.ts`: the model page's "Sync from MakerWorld/Printables"
button diffs the model's *imported* files against the platform's current file
list and shows a preview dialog (concrete filenames) before applying. The
contract: **imported files mirror upstream, everything else is local** — manual
uploads, generated variants, images, title/description/tags/BOM are never
touched, and files removed upstream are removed locally (safe because the
pre-sync state becomes a version; reason `source-sync`). Matching uses
`model_files.source_file_id` (`profile:<id>` / `scad:<name>` / `doc:<name>` on
MakerWorld, `file:<id>` on Printables — stamped by the importers and required to
stay in lockstep with
`listMakerworldUpstreamFiles`/`listPrintablesUpstreamFiles`), so local renames
survive; change detection compares `model_files.source_modified_at`, an opaque
per-file token (Printables per-file `modified`; MakerWorld per-profile
`publishTime` and raw-file `modelUpdateTime` — **never the design/instance
`updateTime`**, which MakerWorld touches on counter activity: an untouched 2024
design reports today's date, verified live). An unchanged token skips the
download entirely; all `.scad` files share one group token because they arrive
as a single raw-files zip (any change re-stages them all). Neither platform
exposes revision history, so `model_versions` doubles as the record of upstream
changes. Imports predating the feature carry no ids — the first sync adopts them
by filename, treats "upstream modified after the local row's created_at" as
stale, and re-stamps ids/tokens. MakerWorld profile/scad downloads need the
user's Bambu connection, like the importer; Printables sync is fully anonymous.

## MakerWorld collection import

`POST /api/import/collection`, `src/lib/import/makerworld-collection.ts` +
`collection-job.ts`: bulk-imports every model of a
`makerworld.com/…/collections/{id}` list. Collections are "favorites lists" in
Bambu's API: `GET api.bambulab.com/v1/design-service/favorites/{id}` (metadata)
and `…/favorites/{id}/designs?limit=&offset=` (contents, hidden designs
excluded) answer anonymously — undocumented; discovered from MakerWorld's own
frontend (`getFavorites` in the `/collections/[collectionId]` page chunk), so
Bambu can change them at will. Because editing dozens of models by hand is
infeasible, imported designs skip the create-form draft flow: the job runs in
the background (`after()`, like slicing) via an `import_jobs` row
(status/progress/heartbeat), reuses the single-model importer per design,
inserts finished models directly, and links them into a local collection
created up front — already-imported designs (matching `sourceUrl`) are only
linked, which makes re-running a failed job a resume.

The source URL is stored on the collection (`collections.source_url`, rendered
as an "Imported from MakerWorld" link), and "Sync from MakerWorld" (any
signed-in user — syncing counts as editing and uses the syncer's own Bambu
connection; `POST /api/collections/{id}/sync`) re-runs the same job against the
existing collection: designs added remotely import as new models, everything
already in the library is (re-)linked. Sync never deletes — models removed
remotely stay, and a model the user pulled out of the local collection gets
re-linked on the next sync. Local title/description edits are never overwritten.

Slice estimates run as a post-phase so a slow slicer doesn't stall visible
progress. A connected Bambu account is required up front (otherwise every model
would be a file-less shell), jobs are capped at 200 designs, and one runs per
user at a time. Progress surfaces as a ring in the top-right header
(`src/components/import-progress.tsx`) polling `GET /api/import-jobs`, with
cancel (checked between designs) and per-design failures as warnings; a poll
marks heartbeat-stale "running" jobs failed so a server restart doesn't leave a
spinner forever.
