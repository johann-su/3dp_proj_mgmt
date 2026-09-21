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

`sliceInfo.plateCount` is **how many plates the project holds**, read from
`model_settings.config` (or the plate thumbnails) — *not* from
`slice_info.config`, which gets one `<plate>` per plate the slicer has
predictions for. Slicing plate 1 of an 18-plate project writes exactly one, so
reading the count from there made a synced file report "1 plate" while holding
all eighteen. When the predictions cover fewer plates than the project has,
`slicedPlateCount` says how many and the file card reads "5 h … for 1 of 18
plates": the estimate is real, it just is not the whole project's.

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

Deep links hand a file *out* to the slicer; slice-push brings it back. The
**OrcaSlicer plugin** in [`orca-plugin/`](../../orca-plugin/README.md) works out
which model the open project came from, asks whether to update it, and POSTs a
complete project `.3mf` — the settings, filaments, colours and plate layout as
they now stand — to `/api/models/[id]/slice-push`, which attaches it as a new
versioned revision *of the model's own file*. It rides the slicer's own
extension point — no fork, no daemon, no polling of an undocumented cloud API
(see the issue for why the Orca/Bambu cloud-backend routes were rejected).

What it replaces is a manual round trip: download the `.3mf`, change it, save
it, edit the model, re-upload. So the artifact matters. Pushing G-code (which
is all the slicing hook is given, and all the first two versions of this sent)
closes none of that loop, which is why the current design assembles the project
off disk instead — see
[Project sync](#project-sync-what-actually-keeps-the-3mf-current).

### Why a plugin and not a post-processing script

This was first built as a post-processing script, and the mechanism was the
problem — worth writing down, because the pull to "just ship a script" is
strong. That field lives on the **process preset**, while the push target is a
**model**: a per-model token meant editing (and dirtying) your print profile
every time you sliced something else. The plugin inverts it — installed once,
credential in its own config, target resolved at slice time — which is why the
token is now per *user and machine* rather than per model.

### The three things the slicer will not give you

Design around these; they are host-API facts, not gaps in our code, and each is
an open ask in [OrcaSlicer discussion
#14878](https://github.com/OrcaSlicer/OrcaSlicer/discussions/14878).

0. **The hook only runs for process presets that opt in.** `PluginHooks.cpp`
   and `PostProcessor.cpp` both dispatch off the print config's
   `slicing_pipeline_plugin` option — a `plugin_picker` under Print Settings →
   Others (Advanced mode) — and return immediately when it is empty. Enabling
   the plugin in the Plugins dialog does *not* enable the hook. So a per-preset
   step survives the redesign; what does not survive is a per-*model* one, which
   is the part that made the script version unusable. The plugin's own window
   therefore also offers a path that scans the user's export folders and pushes
   a file with no preset involvement at all — the only route that works before
   anyone has touched Print Settings.
1. **The hook hands over `.gcode`, not a project file — and only on export.**
   `Step.psGCodePostProcess` fires inside the G-code **export** path (or a
   printer upload) on a *temporary* working copy, **before** it is written to
   the user's chosen path — so no final `.gcode` and no Bambu-style
   `.gcode.3mf` bundle exists yet, and `ctx.print`/`ctx.object` are None.
   **When** it fires depends on the printer
   (`BackgroundSlicingProcess.cpp`): on a **BBL printer** it runs right after
   each plate is sliced (`if (m_fff_print->is_BBL_printer())
   run_post_process_scripts(...)`), once per plate; everywhere else it runs from
   `finalize_gcode()`, i.e. on export or upload. Don't design around getting the
   project file *from the hook*; you can't — get it off disk instead
   ([Project sync](#project-sync-what-actually-keeps-the-3mf-current) below).

   Two consequences worth holding on to. **The "output name" is not a name**: on
   a BBL printer the plate's temp path is passed as both the artifact and
   `output_name` (`.<pid>.<counter>.gcode`, where the counter is a global
   allocation counter and *not* the plate index), so a naive implementation
   stores `.74890.3.gcode`. And **one firing is one plate** — no seam hands
   over a multi-plate project, so per-plate G-code (the fallback path) is named
   `<file>_plate_<n>.gcode`, while a sync collapses every firing of one slice
   into a single push. The `replaces=<fileId>` param is what keeps a revision's
   name: the pusher names the file it is revising (which it knows from
   `/resolve`), the row keeps its **filename**, and the family check stops a
   `.gcode` from taking over a `.3mf` row.
2. **The hook may not show UI.** It runs on the slicing worker thread, which the
   UI thread can be blocked waiting on, so a marshaled UI call from there can
   deadlock the app. The "update the catalogue or keep it local?" question is
   therefore asked from a **script capability** (a window the user opens), not
   from the hook — the hook queues.
3. **There is no structured slice result.** Print time and filament use still
   come from parsing, which is why `src/lib/gcode-stats.ts` exists — and the
   numbers are not where you would look for them. **OrcaSlicer on a Bambu
   printer writes the print time in the G-code *header*** (line 3, as
   `; model printing time: 4h 53m 23s; total estimated time: 5h 0m 4s` — both
   times on one line) and only the filament totals at the end, while
   PrusaSlicer writes everything in the footer. So `GcodeStatsWindow` keeps the
   first 64 KB *and* the last 128 KB of the stream, and every capture stops at
   a `;` — a greedy one hands the duration parser both of Bambu's times and
   reports a 5 h print as 9 h 53. `total estimated time` is preferred because
   it is what the slicer's own UI shows and what `slice_info.config` stores as
   `prediction`.

### Project sync: what actually keeps the `.3mf` current

The point of the whole feature, and the thing the first two versions did not
do. A pushed plate of `.gcode` leaves the catalogue's project file stale: it is
inert in every `.3mf`-gated surface (3D preview, deep links), it is hundreds of
MB, and none of the **settings** the user just worked out come back with it.
What comes back instead is the project itself, assembled on the slicer's own
machine out of two things already on disk.

**OrcaSlicer's project checkpoint.** Auto backup (Preferences → *Auto backup*,
on by default, `backup_interval` 10 s) keeps a crash-recovery copy of the open
project in
`<temp>/orcaslicer_<uid>/orcaslicer_model/<Day_Mon_D>/<HH_MM_SS>#<pid>#<n>/`:

```
.3mf         Orca's own 3MF writer: 3D/3dmodel.model (+ _rels, i.e. the plate
             layout) and every Metadata/*.config — process settings, filament
             and colour assignment, per-object overrides, live slice_info.
             Everything except the meshes.
origin.txt   the path the project was loaded from
lock.txt     the pid that owns it
3D/Objects/  mesh parts, written only for objects edited or added here
Auxiliaries/ the project's own files (manuals, pictures), loose
Metadata/.<pid>.<n>.gcode   the sliced plates — what the hook is handed
```

The hook's artifact lives *inside* that directory, so `project_checkpoint()`
walks up from `ctx.gcode_path`. The window has no context and matches
`lock.txt` against `os.getpid()` instead — a second OrcaSlicer window keeps its
own checkpoint, and syncing one project onto another project's model is the
failure with no cheap undo.

**The merge** (`assemble_project`, part by part through `zipfile`). The rule
that makes it work took two broken attempts to find, so it is worth stating
plainly: **the checkpoint decides everything except geometry, and is copied
verbatim.** Its `3D/3dmodel.model` and `Metadata/*.config` go in untouched; the
origin supplies the meshes, rewritten into the parts and under the object ids
the checkpoint's model asks for.

Why it cannot be done the other way round — mapping the checkpoint's references
onto the origin's numbering — is four facts that only collide in the merged
file:

1. a checkpoint numbers objects in its own live sequence (`65536 + n`), while
   the file the project was saved to carries the numbering from that save:
   `…/HATCH FRONT 1.STL_6.model objectid="65542"` sits next to a part that
   defines `<object id="40">`. The part *names* match, which is why this looks
   fine until something tries to open the file;
2. a save **dedups identical meshes** — two copies of one object share a part,
   and the duplicate's part is named but written *empty* — so matching parts by
   name is not enough either;
3. **three.js keys objects by id in one namespace for the whole archive** and
   ignores `p:path` (`buildObjects` in `3MFLoader.js`), while a save allocates
   the model's wrapper objects and the parts' mesh objects from one sequence so
   they never collide. Carry the origin's ids over and 13 of them collide with
   the checkpoint's wrappers: the file opens in OrcaSlicer, slices in
   PrusaSlicer (which resolves by path), and renders an **empty scene** in the
   browser;
4. `Metadata/model_settings.config` keys per-object settings on the model's
   object ids **and per-part settings on the component ids** (`<part
   id="65549">`), so renumbering either without rewriting that file silently
   drops extruder assignments, painted supports and part transforms — the very
   settings a sync exists to carry.

Both of those shipped to a real catalogue (an unloadable file, then an empty
preview) before the direction was inverted. What makes the transplant possible
is the production extension's `p:UUID` on each component: byte-identical in the
checkpoint and in the saved file, so `component_map()` turns the origin's model
into `p:UUID → (part, object id)` and each needed object is lifted out of that
part (`object_elements`, `objects_part`) and written under the id the
checkpoint wants. Nothing is returned until `unresolved_references()` and
`duplicate_object_ids()` both come back empty —
`orca-plugin/assemble.test.py` reproduces all four facts in fixtures and fails
if either guard is removed. Run it after touching the merge.

Four more things the merge has to keep doing:

- **Strip the plugin's own config out of `project_settings.config`**
  (`strip_plugin_settings`). OrcaSlicer keeps a capability's configuration in
  the **print config** (`print_plugin_config_overrides`), so the push token — a
  long-lived, edit-equivalent credential — sits in the checkpoint's settings in
  plaintext and would land in the catalogue, downloadable by anyone who can see
  the model. Same reason `State.save_settings` writes the token only to the
  plugin's own folder, and why `migrate_token_out_of_config` rewrites the
  capability config without it on load: a token left there is written into
  every project the user saves or exports.
- **Drop mesh parts the new `3dmodel.model.rels` no longer references**, or the
  file grows by every object anyone ever deleted.
- **Keep `Auxiliaries/`.** That is where a project's manual and pictures live,
  and the importer reads them (`src/lib/threemf.ts`).
- **Embed G-code only when asked.** `include_gcode` (default off) writes
  `Metadata/plate_<n>.gcode` plus an uppercase, unterminated `.gcode.md5` — the
  layout of Bambu's own "export all plates sliced file" bundle, which needs
  `[Content_Types].xml` to declare the `gcode` extension. Default off because
  the project already carries the slicer's predictions, while six plates add
  ~60 MB to every revision against a 30-version cap.

**Freshness is the one soft spot.** The checkpoint is rewritten when the
*model* changes, not when a slice finishes, so its `slice_info` can lag by a
whole slice. Two mitigations, both deliberate. The window shows the
checkpoint's age, and when the project is dirty *and* the checkpoint is already
older than one interval it waits up to 14 s for the mtime to advance
(`_await_checkpoint`) — there is no host call that forces a checkpoint, so
don't go looking for one. And the plugin parses the G-code the hook handed
it and sends `printTimeSeconds`/`filamentGrams` in `X-Slice-Push-Meta` —
totalled across the plates it saw, and held *per plate* on the way there
(`sum_plate_stats`) because the hook fires more than once for the same plate
and adding those would report a project as taking twice as long as it does; `applyPushedEstimate` (`src/lib/slicer.ts`) applies those
when the file carried no predictions of its own — and also *over* an estimate
the slicer service produced, since ours is a generic profile and theirs is
their own slicer on their own printer. Never over the file's own numbers (those
describe the file) and never over `failed`, which is worth flagging.

**One sync is one version.** Every firing of a single "Slice all" merges into
one queued entry, keyed on the origin path (`queue_upsert_sync`), so a sync
needs none of the `batch` machinery below.

**With no checkpoint, nothing is pushed.** The hook reports why and stops — it
does *not* fall back to the plate's G-code, which was the old behaviour and put
rows in the catalogue that nothing could use. Three states, and they get
different messages because they need different answers: a checkpoint directory
with **no snapshot yet** (`ready: false` — opening a project creates the folder,
`origin.txt` and `lock.txt`, and the `.3mf` lands a few seconds after the first
change, so "turn on Auto backup" would be wrong advice); **no directory at
all** (Auto backup really is off); and a snapshot whose **origin file is gone**
(nothing to take meshes from). The window says the same three things, and its
*Exported files* list — projects only — is the way round all of them.

### What the endpoints do

`POST /api/slice-push/resolve` turns a file on the slicing machine into a model.
The plugin sends SHA-256s of the files the project was loaded from (the
checkpoint's `origin.txt` first — per-object `input_file` paths can be the STLs
a project was assembled out of, which the catalogue never served), their names,
and the 3MF's Bambu design id; the route matches them against
`model_files.content_hash` (exact — the catalogue served those bytes), then
filename, then `models.sourceUrl` for the design id, then — only when the caller
asks — a title `query` the user typed. Results come back ranked
(`rankPushCandidates`). **Only a lone hash match is ever pushed to unattended**
(`isConfidentMatch`): a mistargeted revision is the one failure with no cheap
undo. `GET /api/slice-push/ping` exists so setup fails at setup time.

Three things make this work on a real catalogue rather than a fresh one, and
all three exist because the first live test resolved *nothing*:

- **`content_hash` is null on anything uploaded before issue #118**, and a null
  hash never matches — so on an existing instance the exact path is dead until
  `scripts/backfill-content-hashes.ts` (`npm run db:backfill-hashes`) has run
  once. Say so before blaming the matching.
- **The name on disk is not the name in the catalogue.** "Open in slicer"
  downloads to `~/Downloads`, where the OS makes the name unique:
  `fuselage.3mf` arrives as `fuselage(7).3mf` with *identical bytes*. The
  plugin therefore sends both the raw name and a `(n)`-stripped variant.
- **The user can always just pick.** Title search plus a remembered
  project→model mapping (plugin-side, keyed on content hash or stripped name)
  means a project only has to be identified once, however badly it resolves.

`POST /api/models/[id]/slice-push` takes the bytes. A per-plate G-code slice
can arrive as one push per plate, so it also takes `batch=<id>` (with
`batchFinal=1` on the last): every push in a batch still runs
`ensureBaselineVersion`, but only the final one calls `recordVersion`, and its
snapshot contains the whole batch. Without that, one "Slice all" on an 18-plate
project would write 18 version rows and evict the model's real history through
the 30-version cap. (A *sync* needs none of this — it is one push for the whole
project.) It accepts both artifacts:

- **`.3mf`** — the normal case: a synced project (or a hand-pushed project /
  `.gcode.3mf` bundle). Marked `pending` and left to the existing pipeline,
  which reads `slice_info`/`project_settings` as usual. No new parsing.
- **`.gcode`** — the hook's own artifact. **The plugin never pushes one**
  (`PUSH_SUFFIXES`): a raw plate of G-code is a row no preview, deep link or
  estimate can use, it is superseded by the next sync, and the sliced G-code
  belongs *inside* the project (`include_gcode`). The route still accepts it
  for the stand-alone CLI's explicit `--push-gcode`, on a machine with no
  checkpoint to read. Its stats are scraped from the head and tail
  windows **as the bytes stream past to S3** (`GcodeStatsWindow` +
  `parseGcodeStats`, `src/lib/gcode-stats.ts`): a pushed G-code is routinely
  hundreds of MB, so it is never buffered whole or read back out of S3.
  Resolved inline to `sliceStatus: "ok"` / `sliceSource: "embedded"` — real
  predictions from the user's own slicer for their own hardware, so the UI
  shows them **without** the `~` it puts on our generic-profile estimates.
  This path must keep working with no `SLICER_URL` at all, which is why the
  parser lives in the app and not behind the slicer service.

A file does not say which machine, plate or presets produced it — a `.gcode`
says none of it, and a `.3mf` says everything except the preset *names*. The
plugin can read all of it live, so it sends a small JSON object in
`X-Slice-Push-Meta` which `parsePushMeta` folds into the same `printerInfo`
column the 3MF parser fills. It is written for **both** artifacts and is the
seed the 3MF parse overwrites moments later, so a project whose config cannot
be parsed still shows what produced it. `parsePushStats` reads the two estimate
fields out of the same header (see *Project sync* for when they are used). All
of it is client-supplied and parsed defensively: junk metadata must never cost
us the bytes.

`presets` is the one field a 3MF parse must never overwrite with nothing, which
is why `estimateFile` carries the existing value forward when it cannot produce
one: the preset *names* exist only in the live slicer, so erasing them on the
re-parse that follows every sync (or on any later re-slice) would lose them for
good.

`parseGcodeStats` is a deliberate **near-duplicate** of the one in
`slicer/lib.mjs` rather than a shared module: that one runs in the slicer
service container (a separate deployable, no build step) and only ever reads
G-code our own PrusaSlicer CLI produced, so it can assume PrusaSlicer's
spelling. This one reads whatever a user's slicer wrote, so it also knows Bambu
Studio's `key: value` forms, its both-times-on-one-line header, and the
head-as-well-as-tail window that needs. Adding a dialect belongs in *this*
copy. There is a *third*, smaller copy in the plugin (`parse_gcode_stats`),
which exists because a synced project ships no G-code for the server to read —
this file's list stays canonical.

Three things the ingest route must keep doing:

- **Authenticate by token, not session.** The slicer has no cookie — the same
  constraint that forces the token-in-path download route. A **stored,
  revocable** token (`push_tokens`, `src/lib/push-token.ts` for the pure
  crypto, `src/lib/push-tokens.ts` for the lookup), not the HMAC in
  `file-token.ts`: that one is short-lived, download-scoped, and being a pure
  signature cannot be revoked without rotating the instance secret. Only the
  SHA-256 of the secret is stored. These are the only *write* surfaces in the
  app that take something other than a session — see
  [auth-and-access.md](./auth-and-access.md).
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
(`src/lib/slice-push.ts`) widens what a *token holder* may attach to a model,
not what the create/edit upload picker accepts. A pushed `.gcode` row survives
later edits because `validateUploads` only runs on newly uploaded files, and it
stays inert in the `.3mf`-gated UI (3D preview, slicer deep links). Its stored
content type falls through to `application/octet-stream`, which is what we
want — never a `text/*` that a browser would render inline.

The feature is **opt-in and off by default**: no token minted → no push surface
exists. Tokens are minted and revoked in Settings → Push from slicer; the model
page's "Push from slicer" dialog only explains the setup, because there is
nothing per-model to configure. The plugin file doubles as a stand-alone CLI for
builds without a plugin system (2.4.x, Bambu Studio, PrusaSlicer): as a
post-processing script it resolves by filename alone and **always exits 0** so a
push failure never breaks the user's slice, and `--sync` drives the project
merge from outside the slicer — with `--out`, assembling the file and pushing
nothing, which is how the merge is exercised without a slicer or an instance.

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
