# Print Vault plugin for OrcaSlicer

Sends the project you have open back to the model it came from, as a new
revision of that model's own `.3mf` — the process settings, the filaments and
their colours, where the objects sit on which plate. What it replaces is the
manual round trip: download the file, change it, save it, edit the model,
upload it again. Issue #122; the server side is `/api/slice-push/*` and
`docs/architecture/slicing.md`.

One file: `orca_print_vault_plugin_any.py`. It is both the OrcaSlicer plugin
and, on builds without a plugin system, a stand-alone CLI.

## Requirements

The plugin system is **OrcaSlicer 2.5 nightly or newer** — 2.4.2 and Bambu
Studio/PrusaSlicer do not have it. Check: the app bundle ships an embedded
CPython (`Contents/Resources/python/`) and the main menu has a **Plugins**
entry. On anything older, use the [CLI fallback](#cli-fallback) below.

**Keep Preferences → *Auto backup* on** (it is by default). That is the
checkpoint a sync reads; see [How it reads the
project](#how-it-reads-the-project).

## Install

1. Print Vault → **Settings → Push from slicer** → create a token, and copy the
   config it shows you (it is the only time the token is displayed).
2. OrcaSlicer → **Plugins** → *Install local plugin* → pick
   `orca_print_vault_plugin_any.py`.
3. Open **Plugins → Sync with Print Vault → ▷ Run**, paste the instance URL and
   the token into **Connect**, and save — it verifies the connection first. The
   **Config** tab of *Push sliced file to Print Vault* takes the same values,
   but prefer the window: OrcaSlicer saves a capability's config with your
   **print profile**, so a token entered there would be written into every
   project you save or export. The plugin moves one it finds there into its own
   folder the first time it runs.
4. Optional — **turn the hook on for the profile you slice with**: Print
   Settings → **Others** → *Slicing Pipeline Plugin* → select **Push sliced
   file to Print Vault**, then save the profile. That makes every slice queue a
   sync, so the window has an answer waiting. It is **Advanced mode** only and
   per profile, and nothing else depends on it: the window can sync the open
   project whether or not any slice reached the plugin.
5. OrcaSlicer will ask for permission the first time the plugin uses the
   network, reads a file, or writes to its own folder — that is the host's
   audit hook, and the answer is remembered per plugin.

## Syncing a project

Open a file from a model, change what you came to change, and run **Plugins →
Sync with Print Vault** (or put it on the Actions Speed Dial, where it can be
pinned as a tile — one click from the plate). The window's first card is the
project itself, and it lists exactly what the push will contain:

- the file it was opened from, and the catalogue model that resolves to;
- settings, filaments and layout, with the age of the checkpoint they come from
  ("checkpointed 8 s ago") and a note when there are changes newer than that;
- slice predictions, per plate, when the checkpoint has them;
- what your last slice adds, if the hook captured one — its plates, its
  estimate, and its G-code when `include_gcode` is on.

**There is one button**, *Update the model's file*, and one push: the project
plus whatever the last slice added to it. (An earlier version showed the queued
slice as a second card with its own button, which looked like two different
things to do.) A slice from a project that is *not* the one on the plate does
get its own card, because that is a different file going to a different model.

Nothing has to be exported, and the project does not have to have been sliced.
A sync replaces the model's own file, keeps its name, and lands as one new
version in the model's history.

### After every slice

With the hook enabled (step 4), a slice queues a sync and then — depending on
**mode**:

| mode | behaviour |
|---|---|
| `ask` (default) | Queues it. You press the button in the window. Slicing 18 plates queues **one** sync, not eighteen: every firing describes the same project. |
| `auto` | Pushes immediately, but only when the model is an unambiguous exact-file match and you have ticked *always* for it. Otherwise it falls back to queueing. Eighteen plates are still one push: the checkpoint describes the same project state each time. With *include_gcode* on it always waits for the window, so one push can carry every plate's G-code. |
| `off` | Captures nothing. The window still works. |

`prompt_after_slice` additionally raises the window by itself when a slice
lands, refreshing it in place rather than opening anything new. It is **off by
default and experimental** — see *Known limits*.

Independent of all of it, the window lists **exported files** found in your
export folders (`~/Downloads` and `~/Desktop` by default, or set
`export_dirs`). That is the fallback for a project with no checkpoint to read.

### The sliced G-code

Not uploaded, by default: the project carries the slicer's own per-plate
predictions, so the catalogue gets real print times without hundreds of MB per
revision. Tick **Put the sliced G-code inside the .3mf** (`include_gcode`) and
each plate's G-code is embedded in the pushed project as
`Metadata/plate_<n>.gcode`, the way OrcaSlicer's own *Export all plates sliced
file* writes it — so the stored file is printable as it stands, and there is
still no separate `.gcode` row on the model.

## How it reads the project

`Step.psGCodePostProcess` — the only seam that hands over sliced output — hands
over one plate's **G-code** on a temp path, with `ctx.print`/`ctx.object` both
None. There is no project file at that moment and no way to ask for one.

OrcaSlicer is writing one anyway. Auto backup keeps a crash-recovery checkpoint
of the open project next to that temp G-code:

```
<temp>/orcaslicer_<uid>/orcaslicer_model/<Day_Mon_D>/<HH_MM_SS>#<pid>#<n>/
  .3mf          3dmodel.model (+ rels) and every Metadata/*.config — settings,
                filaments, colours, plate layout, slice predictions. No meshes.
  origin.txt    the path the project was loaded from
  lock.txt      the pid that owns it
  3D/Objects/   mesh parts, written only for objects edited or added here
  Metadata/.<pid>.<n>.gcode   the sliced plates
```

The meshes are still in the file named by `origin.txt`, so overlaying the
checkpoint onto that file gives a complete project in which every part was
written by OrcaSlicer itself. That is what gets pushed.

The checkpoint is copied **verbatim** — its model and its `Metadata/*.config`
are one structure, and the per-object settings are keyed on the object ids in
it — so the meshes are the part that moves: for every object the model
references, the matching mesh is lifted out of the saved file and written under
the id the model asks for. The `p:UUID` on each component is what makes that
lookup possible, since object ids are renumbered on every save and identical
meshes are stored once (the duplicates' parts named but left empty). Nothing is
pushed unless every reference resolves and no object id is claimed twice; a
file that fails either check would open in OrcaSlicer and nowhere else.

The plugin also strips its own configuration out of
`project_settings.config`: OrcaSlicer keeps plugin settings in the *print*
config, so the push token would otherwise ride along into the catalogue.

### How it knows which model

`origin.txt` names the `.3mf` the project was opened from, and
`orca.host.model()` adds each object's `input_file` and the Bambu design id.
The plugin hashes those files and asks `/api/slice-push/resolve`. A file the
catalogue served hashes exactly equal to the stored object, so the usual answer
is a single exact match and you are never asked. Filename and design-id matches
are offered as weaker candidates in the window, and are never pushed to
unattended. Whatever you pick is remembered for that project.

## Known limits

Properties of the host API today, not of this plugin. They are the substance of
what we asked for in [OrcaSlicer discussion
#14878](https://github.com/OrcaSlicer/OrcaSlicer/discussions/14878).

- **A sync is only as current as the last checkpoint.** Auto backup writes one
  a few seconds after the model changes — but *not* when a slice finishes, so
  its predictions can be a slice behind. The window shows the age and waits for
  the next checkpoint when the project is dirty; the footer of the G-code the
  hook was handed is parsed and sent as a fallback estimate. There is no call
  that forces a checkpoint. Saving the project (⌘S) is the manual equivalent.
- **The slicing hook is opt-in per process preset.** `slicing_pipeline_plugin`
  is a preset option, so enabling a plugin globally does nothing until each
  profile you slice with names it. What is missing is a *slicing finished*
  event; what makes it survivable is that no credential and no model id live in
  the preset, and that the window needs none of it.
- **The slicing hook may not touch the UI.** It runs on the slicing worker
  thread, which the UI thread can be blocked waiting on, so a dialog raised
  from there can deadlock the app. That is why "ask" queues rather than asks,
  and why `prompt_after_slice` (a short-lived thread that waits out the export
  and then raises the window) is opt-in: it leans on timing nobody has
  promised.
- **No structured slice result.** Print time and filament use are read by
  parsing G-code. An API for the numbers OrcaSlicer already computed would
  remove that parsing from three places.
- **No way to add a button to OrcaSlicer's own UI.** The main toolbar, the
  plate context menu and the export split-button are C++ with no extension
  point. A script capability appears in the Plugins dialog and as an **Actions
  Speed Dial** entry (searchable, pinnable as a tile), and `orca.pages` can add
  a top-level tab; that is the whole surface available.
- **The hook can fire more than once per slice** (file export and printer
  upload each get their own working copy) and once per plate. All of those
  firings merge into one queued sync for the project.
- **The output name is a lie on Bambu printers.** `ctx.output_name` is the same
  temp path as the artifact (`.<pid>.<counter>.gcode`, and the counter is a
  global allocation counter, not the plate index), so names come from the
  catalogue file the project was resolved to instead.

## When a project cannot be synced

The window says which, and the *Exported files* list is the way round all of
them:

| Situation | What happens |
|---|---|
| The project has just been opened and nothing changed yet | Its checkpoint folder exists but holds no snapshot — OrcaSlicer writes one a few seconds after the first change. The window says so and offers *check again*. |
| Auto backup is off | Nothing is pushed, and nothing can be: the settings and the layout are only readable from a checkpoint. |
| A slice arrives with no checkpoint to merge into | Nothing is pushed. A plate of raw G-code is not worth a row in the catalogue, so it is never uploaded on its own. |
| The file the project was opened from has been moved or deleted | Nothing to merge the changes into. Re-download it from Print Vault, or export a sliced file and push that. |
| A mesh is in neither the checkpoint nor that file, or an object id is claimed twice | The sync is refused rather than pushing a project that will not open. |

## CLI fallback

The same file works as a post-processing script on OrcaSlicer 2.4.x, Bambu
Studio and PrusaSlicer. Stdlib only — no packages to install.

```sh
# store the connection once (also used by the plugin later, on this machine)
python3 orca_print_vault_plugin_any.py --url https://vault.example.com --token pvpush_… --save --check
```

Then in **Print Settings → Others → Post-processing Scripts**:

```
python3 /full/path/to/orca_print_vault_plugin_any.py ;
```

It is deliberately the weaker half: a post-processing script cannot ask a
question and cannot see which project is open. Handed a `.gcode`, it **syncs
the project that G-code came from** rather than uploading the file — the
checkpoint is on disk whether or not the build has a plugin system — and
resolves the model by name, pushing only when exactly one matches (`--model
<id>` overrides). `--push-gcode` sends the G-code file itself instead, which is
the only way a raw `.gcode` ever reaches the catalogue. It never fails a print:
every error path exits 0 unless you pass `--strict`, which is what you want
while setting it up.

`--sync` does the project merge from the command line instead, against the
newest checkpoint on the machine (or `--checkpoint <dir>`):

```sh
# assemble the project and push it
python3 orca_print_vault_plugin_any.py --sync --strict

# or just build the file and look at it — no instance involved
python3 orca_print_vault_plugin_any.py --sync --out /tmp/synced.3mf --strict
```
