# Slicer estimates & "open in slicer" deep links

*Read before touching print estimates, the slicer service, or the slicer deep
links. Update in the same PR that changes this behaviour.*

## Print estimates

Print estimates come from two sources. Files sliced in Bambu Studio /
OrcaSlicer embed per-plate predictions in `Metadata/slice_info.config`, which
are read directly from S3 via ranged GETs (`src/lib/threemf-remote.ts`).
Unsliced `.3mf` files are sent to the **slicer service** (`slicer/`, the third
compose container): a zero-dependency Node HTTP wrapper around the headless
PrusaSlicer CLI (Debian's `prusa-slicer` package) that parses print time and
filament use from the G-code footer. The service honors the settings embedded
in the file — Bambu/Orca `project_settings.config` keys are translated to their
PrusaSlicer equivalents (machine limits, speeds, accelerations, layer height,
infill, and the filament of the extruder the objects actually use),
PrusaSlicer projects load their own `Slic3r_PE.config` — falling back to a
generic 0.4 mm/PLA profile (`slicer/config.ini`) for files without settings.
Only whitelisted keys are copied (a crafted archive can't smuggle in
`post_process` scripts), and the bed is a huge virtual plate so multi-plate
Bambu projects (whose world coordinates extend far past the physical bed) still
slice; estimates are totals across all plates.

Slicing runs in the background after upload (`after()` in the model actions,
`src/lib/slicer.ts`); results land on `model_files` (`slice_status`,
`print_time_seconds`, `filament_grams`, …) together with the hardware the
project was set up for (`printer_info`: printer model, nozzle, build plate,
used filaments, and physical bed size — the latter parsed from the embedded
`printable_area`/`bed_shape` polygon, or a known-model lookup, and used to draw
the 3D preview's plate at real dimensions, issue #80; the preview's plate-size
dropdown can swap in any of the `BED_PRESETS` in `src/lib/printer-beds.ts` to
check fit against another printer; plus `usesSupport`, from the config's
`enable_support`/`support_material` — tri-state on purpose, since a *missing*
key means "the config didn't say", not "no supports", and the model page only
badges the positive case), which the model page
shows per file. Slicer-derived numbers
are still approximations (PrusaSlicer's time estimator, not the printer's
firmware) and shown with a `~` prefix; files PrusaSlicer cannot slice are
flagged on the model page so the uploader notices a broken or unprintable file.
Legacy `.step` files (from before Onshape imports switched to 3MF) and files
uploaded before this feature are skipped. The service is optional: without
`SLICER_URL`, unsliced files simply show no estimates and stay `pending`.

### Queueing a file for (re-)slicing

Every `.3mf` row in the create/edit wizard carries a toggle for handing that
file to the slicer **when the form is saved** — nothing runs on the click
itself, so one save covers the whole edit. The two sides want opposite
defaults, so the form stores *overrides* of a per-entry default
(`model-form-state.ts`: `defaultQueuedForSlicing` / `isQueuedForSlicing` /
`toggleSliceQueue`) rather than a plain list: a file being added is queued (an
upload queues it anyway) and can be taken out; a file already on the model is
not, and adding it back re-slices. Keeping the map empty for an untouched form
is what stops it from reading as dirty, so a toggle-and-toggle-back leaves no
trace.

The two directions reach the actions differently, because a file being uploaded
has no id yet: `skipSliceKeys` (S3 keys within `newFiles`, so `createModel`/
`updateModel` insert `sliceStatus: null` instead of `"pending"`) and
`resliceFileIds` (ids of kept files, which `updateModel` flips back to
`"pending"`). Both are advisory — the server still gates on `sliceEligible` and
on the ids belonging to the model.

The re-slice flip happens **outside** the update transaction on purpose: the
version snapshot covers `sliceStatus`/`printer_info`, so flipping it inside
would record a version for what is only a request to recompute (the slicer's
own writes land outside versioning too, for the same reason). Old estimates
stay visible until the new ones replace them. Re-slicing a file that carries
embedded Bambu/Orca predictions costs only a few ranged S3 reads — it re-reads
`printer_info` and returns before the PrusaSlicer path, which is what makes it
a cheap way to backfill newly parsed fields onto older models, even on an
instance with no `SLICER_URL`.

### Filaments: per slot, and the multi-nozzle question

`printer_info.filamentTypes` is **one entry per filament slot the objects
actually print from, in slot order, and deliberately not deduped** — red PLA in
slot 1 plus black PLA in slot 2 is a two-colour print, and a deduped `["PLA"]`
would read as a single-colour one. `filamentColors` holds the matching
`filament_colour` hexes and is index-parallel by contract: it's dropped entirely
(rather than padded) when any used slot has no usable colour, so the two arrays
always zip 1:1 for the badges. Rows written before this shipped keep their old
deduped types and no colours, so they under-report multi-colour until re-sliced.
`filamentSummary()` in `src/lib/printer-info.ts` does the zipping and the
multi-colour/multi-material call for both the model page and the MCP payload.

Which slots count is decided by the archive's per-object `extruder` keys —
Bambu/Orca's `model_settings.config`, PrusaSlicer's own
`Slic3r_PE_model.config` (needed because an MMU/XL profile lists a filament per
physical extruder whether or not it's used; a `value="0"` on a part means
"inherit the object's extruder", not slot 0). No such entry → assume slot 1.

`requiresMultiNozzle` answers a *hardware* question, not a colour count: an
AMS/MMU multiplexes many filaments through one nozzle, while an H2D, Prusa XL or
IDEX genuinely needs a second nozzle the visitor may not own. It is true only
when the used slots sit on different physical extruders, which each slicer says
differently:

- **Bambu/Orca** — `filament_map` maps each slot to a physical extruder and is
  only written by dual-nozzle machines. Without it, a single-slot print or a
  one-entry `nozzle_diameter` (`nozzle_diameter` has one entry *per physical
  extruder*) settles it as false; anything else stays undefined.
- **PrusaSlicer/Orca ini** — `single_extruder_multi_material = 1` is the MMU
  multiplexer, so false; the same multi-slot print with it `0` is a toolchanger.

Undefined follows the `usesSupport` convention — a missing key means "the config
didn't say", not false. `nozzleDiameterMm` stays "the nozzle actually used": on
a dual-nozzle machine it indexes `nozzle_diameter` by the extruder the objects
print from, not by the machine's first.

## Slice-push: the return leg (issue #122)

Deep links hand a file *out* to the slicer; slice-push brings it back.
`POST /api/models/[id]/slice-push` accepts the file a slicer's
**post-processing script** just produced and attaches it to the model as a new
versioned revision, so a tuned print profile lands in the catalogue without a
manual re-upload. It rides the slicer's own hook — no fork, no daemon, no
polling of an undocumented cloud API (see the issue for why the Orca/Bambu
cloud-backend routes were rejected).

**The hook hands over `.gcode`, not a project file.** OrcaSlicer/PrusaSlicer
run post-processing scripts inside `BackgroundSlicingProcess::finalize_gcode`,
on a *temporary* G-code copy, **before** it is exported to the user's chosen
path — so at hook time no final `.gcode` and no Bambu-style `.gcode.3mf` bundle
exists yet. Don't design around getting the project file from the hook; you
can't. The endpoint therefore accepts both:

- **`.gcode`** — the hook's artifact. Its footer stats are scraped from a
  rolling tail window **as the bytes stream past to S3** (`TailBuffer` +
  `parseGcodeStats`, `src/lib/gcode-stats.ts`): a pushed G-code is routinely
  hundreds of MB, so it is never buffered whole or read back out of S3.
  Resolved inline to `sliceStatus: "ok"` / `sliceSource: "embedded"` — real
  predictions from the user's own slicer for their own hardware, so the UI
  shows them **without** the `~` it puts on our generic-profile estimates.
  This path must keep working with no `SLICER_URL` at all, which is why the
  parser lives in the app and not behind the slicer service.
- **`.3mf`** — a project file or a `.gcode.3mf` bundle, pushed by hand or by a
  slicer configured to export one. Marked `pending` and left to the existing
  pipeline, which reads `slice_info`/`project_settings` as usual. No new
  parsing.

`parseGcodeStats` is a deliberate **near-duplicate** of the one in
`slicer/lib.mjs` rather than a shared module: that one runs in the slicer
service container (a separate deployable, no build step) and only ever reads
G-code our own PrusaSlicer CLI produced, so it can assume PrusaSlicer's
spelling. This one reads whatever a user's slicer wrote, so it also knows Bambu
Studio's `key: value` forms. Adding a dialect belongs in *this* copy.

Three things the route must keep doing:

- **Authenticate by token, not session.** The script runs inside the slicer and
  has no cookie — the same constraint that forces the token-in-path download
  route. A **stored, revocable** token (`model_push_tokens`,
  `src/lib/push-token.ts` for the pure crypto), not the HMAC in
  `file-token.ts`: that one is short-lived, download-scoped, and being a pure
  signature cannot be revoked without rotating the instance secret. Only the
  SHA-256 of the secret is stored; the row is matched on **both** the hash and
  the model id, so a valid token for model A cannot push to model B. This is
  the only *write* surface in the app that takes something other than a
  session — see [auth-and-access.md](./auth-and-access.md).
- **Version like every other mutation.** One transaction,
  `ensureBaselineVersion` first and `recordVersion` last (reason
  `"slice-push"`), S3-deleting only the keys `recordVersion` returns. A repeat
  push of the same plate **replaces the same-named file in place** rather than
  appending (`findReplaceTarget`) — re-slicing exports the same name every
  time, and appending would pile up near-identical rows and churn through the
  30-version cap. The replaced file's old bytes stay in S3 because the snapshot
  taken just before still references them. Generated OpenSCAD variants are
  never replace targets: they're excluded from snapshots, so overwriting one
  would drop bytes no snapshot could restore.
- **Clear `imported` on the replaced row.** The bytes are now this instance's
  own. Leaving the flag set would let the next MakerWorld/Printables source
  sync overwrite the tuned file with the upstream one (`sync-diff.ts` gates on
  `imported`) — losing exactly what the feature exists to keep.

`.gcode` is **not** in `MODEL_EXTENSIONS` on purpose: `PUSH_EXTENSIONS`
(`src/lib/slice-push.ts`) widens what a *token holder* may attach to one model,
not what the create/edit upload picker accepts. A pushed `.gcode` row survives
later edits because `validateUploads` only runs on newly uploaded files, and it
stays inert in the `.3mf`-gated UI (3D preview, slicer deep links). Its stored
content type falls through to `application/octet-stream`, which is what we
want — never a `text/*` that a browser would render inline.

The feature is **opt-in and off by default**: no token minted → no push surface
exists. Tokens are minted from the model page ("Push from slicer") and revoked
there or in Settings → Slicer push; the shipped hook script is
`scripts/slice-push.py` (stdlib-only, and **always exits 0** so a push failure
never breaks the user's slice).

## "Open in slicer" deep links

`src/app/models/[id]/file-download-menu.tsx` hands a `.3mf` to Bambu Studio /
OrcaSlicer via their custom URL schemes. The two apps register different schemes
**and parse the link differently**, so the component builds a *different* URL
per app (`SLICERS[].buildUrl`). Both apps fetch the URL themselves **without
cookies**, so deep links use the token-authenticated path route
`/api/files/<id>/<token>/<name>.3mf`
(`src/app/api/files/[id]/[token]/[filename]/`, reusing the `[id]` handler; the
token must be a path segment, not `?token=`, because Orca keeps the query string
when deriving the filename). Do not try to unify the two link formats — every
"obvious" shared format breaks one of them:

- **Schemes differ from the app names.** OrcaSlicer registers `orcaslicer:`;
  Bambu Studio registers **`bambustudioopen:`** (NOT `bambustudio:`). An
  unregistered scheme fails *silently* — macOS finds no handler and shows
  nothing, not even the "open this app?" prompt. Verify against the installed
  app: `PlistBuddy -c "Print :CFBundleURLTypes"
  /Applications/BambuStudio.app/Contents/Info.plist`.
- **Orca** wants `orcaslicer://open?file=<encoded-url>` (Orca's regex
  `open[\/]?\?file=` also accepts a `open/?` slash — the legacy PrusaSlicer
  "mysterious slash" — but Printables/MakerWorld omit it, so we do too) and (for
  a non-MakerWorld host) treats the *entire* remainder after `file=` as the URL
  to fetch — so **must NOT** get a `&name=` appended (it gets fetched as part of
  the URL and our route 404s: `{"error":"Not found"}`). Orca names the saved file
  from that URL's **last path segment** (`filename_from_url` in `Downloader.cpp`
  — which does **not** strip query strings), so a bare `.../api/files/<id>` saves
  as the UUID with no extension and a `?token=` would end up inside the filename.
  We therefore point Orca at the token+filename-suffixed route
  `.../api/files/<id>/<token>/<name>.3mf` (which ignores the name and reuses the
  `[id]` handler) to get a real `.3mf` name — the same shape as Printables'
  `…/build_tray_v3.step` link. See `Downloader::start_download` in OrcaSlicer.
- **Bambu** (macOS `GUI_App::MacOpenURL`) takes whatever follows
  `bambustudioopen://`, `url_decode`s it once, and treats it as the raw download
  URL — **rejected unless it starts with `http`/`https`** (an `open/?file=`
  prefix silently no-ops *after* the trusted-site prompt). It then splits a
  trailing `&name=` (a literal `.Find("&name=")`, so it must be `&name=`, not
  `?name=`) to name the file and **aborts ("Download failed, unknown file
  format") unless that name ends in `.3mf`** (the bare-UUID URL tail has no
  extension). Match MakerWorld's own links: percent-encode the whole
  `<url>&name=<filename>.3mf` as one blob after the scheme
  (`bambustudioopen://<encodeURIComponent(url + "&name=" + name)>`) so the
  browser can't mangle the literal `&`/`:` before the OS hands it off.
- Cold launch (app not already running): **Bambu works** — `MacOpenURL` stashes
  the URL in `m_download_file_url` and replays it after `post_init`. **Orca does
  not** — its Apple Event arrives before the handler is ready and is dropped, so
  it only launches to the home screen (upstream macOS bug, not fixable here).
  Bambu's `import_model_id` also early-returns if its network plugin/agent isn't
  loaded (`if (!m_agent) return;`), and its trusted-site allowlist only
  auto-trusts makerworld / bblmw CDN / `amazonaws.com` / `aliyuncs.com` hosts
  (any other host — including a self-hosted instance — prompts "not from a
  trusted site"; clicking through is expected).

Slicer deep links are `.3mf`-only — Bambu Studio rejects other filenames, so
`.scad`/`.step` rows render a plain download button instead of
`FileDownloadMenu`.

## Documentation sources

- [Bambu Studio `GUI_App.cpp` URL handler](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/GUI_App.cpp)
  and `Plater::import_model_id` in [`Plater.cpp`](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/Plater.cpp)
- OrcaSlicer's identical [`Plater::import_model_id`](https://github.com/SoftFever/OrcaSlicer/blob/main/src/slic3r/GUI/Plater.cpp)
- [Bambu Studio URL schemes — what doesn't work and why](https://productionshaped.com/notes/2026-05-14-bambu-studio-url-schemes-what-doesnt-work-and-why/)
- [BambuStudio #6120 (URL handler domain restriction)](https://github.com/bambulab/BambuStudio/issues/6120)
