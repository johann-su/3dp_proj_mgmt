# Print Vault plugin for OrcaSlicer

Sends a file you just sliced back to the model it came from, as a new revision
— so a tuned profile lands in the catalogue instead of drifting out of date on
your disk. Issue #122; the server side is `/api/slice-push/*` and
`docs/architecture/slicing.md`.

One file: `orca_print_vault_plugin_any.py`. It is both the OrcaSlicer plugin
and, on builds without a plugin system, a stand-alone post-processing script.

## Requirements

The plugin system is **OrcaSlicer 2.5 nightly or newer** — 2.4.2 and Bambu
Studio/PrusaSlicer do not have it. Check: the app bundle ships an embedded
CPython (`Contents/Resources/python/`) and the main menu has a **Plugins**
entry. On anything older, use the [CLI fallback](#cli-fallback) below.

## Install

1. Print Vault → **Settings → Push from slicer** → create a token, and copy the
   config it shows you (it is the only time the token is displayed).
2. OrcaSlicer → **Plugins** → *Install local plugin* → pick
   `orca_print_vault_plugin_any.py`.
3. In the Plugins dialog, select **Push sliced file to Print Vault** and open
   its **Config** tab, then fill in the instance URL and the token. Both
   capabilities read that one configuration — the review capability's own
   Config tab is empty on purpose. You can also set it from the plugin's own
   window, which verifies the connection before saving it.
4. **Turn the hook on for the profile you slice with**: Print Settings →
   **Others** → *Slicing Pipeline Plugin* → select **Push sliced file to Print
   Vault**, then save the profile. This is not optional and not discoverable —
   a slicing-pipeline capability only runs when the active process preset lists
   it in `slicing_pipeline_plugin`, no matter what the Plugins dialog says.
   The option is **Advanced mode** only, and it is per profile, so repeat it
   for every process preset you slice with. (Skip this if you only want the
   *Exported files* path below.)
5. OrcaSlicer will ask for permission the first time the plugin uses the
   network or writes to its own folder — that is the host's audit hook, and the
   answer is remembered per plugin.

## What happens after a slice

> **Two things have to be true or nothing happens**, and neither is visible
> from the Plugins dialog:
>
> 1. The active **process preset** must list this capability under Print
>    Settings → Others → *Slicing Pipeline Plugin* (Advanced mode). The hook is
>    dispatched from the preset's `slicing_pipeline_plugin` option; with an
>    empty option the plugin is simply never called.
> 2. The slice has to reach the seam. **On a Bambu printer that happens as each
>    plate finishes slicing** — one firing per plate. On every other printer it
>    happens on **export** (*Print plate ▾ → Export plate sliced file*, File →
>    Export → Export G-code) or on a printer upload.
>
> The **Diagnostics** tab shows a `handling export of …` line for every export
> the plugin sees — its absence tells you which of the two is missing.
>
> If you would rather not wire the hook into every profile, the review window's
> **Exported files** list pushes a file straight from your export folder and
> needs neither of the above.

On export the plugin works out which catalogue model the open project came
from, and then — depending on **mode**:

| mode | behaviour |
|---|---|
| `ask` (default) | Queues the slice. You answer in the plugin's own window: **Plugins → Print Vault: review & push → ▷ Run** (or put it on the Actions Speed Dial, which is one click from the plate). The window groups everything queued by target model, so *Slice all* on an 18-plate project is one card with one **Update catalogue with all 18** button — not eighteen questions. |
| `auto` | Pushes immediately, but only when the model is an unambiguous exact-file match and you have ticked *always* for it. Otherwise it falls back to queueing. |
| `off` | Captures nothing. |

Independent of all three, the review window lists **exported files** found in
your export folders (`~/Downloads` and `~/Desktop` by default, or set
`export_dirs`). Press *Match the open plate*, pick the model, and push — no
process preset involved. This is the path to use when you do not want a
per-profile setting, and the one that works when you forgot to add it.

`prompt_after_slice` additionally raises that window by itself when a slice
lands, refreshing it in place as further plates arrive rather than opening
anything new. It is **off by default and experimental** — see *Known limits*.

### How it knows which model

`orca.host.model()` gives the path each object was loaded from and the Bambu
design id in the 3MF. The plugin hashes those files and asks
`/api/slice-push/resolve`. A file the catalogue served hashes exactly equal to
the stored object, so the usual answer is a single exact match and you are never
asked. Filename and design-id matches are offered as weaker candidates in the
window, and are never pushed to unattended.

## Known limits

These are properties of the host API today, not of this plugin. They are the
substance of what we asked for in [OrcaSlicer discussion
#14878](https://github.com/OrcaSlicer/OrcaSlicer/discussions/14878).

- **The slicing hook is opt-in per process preset.** `slicing_pipeline_plugin`
  is a preset option, so enabling a plugin globally does nothing until each
  profile you slice with names it. It is the same shape of friction as
  post-processing scripts, minus the part that mattered — no credential and no
  model id live in the preset, so one checkbox covers the whole catalogue.
- **The slicing hook may not touch the UI.** It runs on the slicing worker
  thread, which the UI thread can be blocked waiting on, so a dialog raised
  from there can deadlock the app. That is why "ask" queues rather than asks,
  and why `prompt_after_slice` (a short-lived thread that waits out the export
  and then raises a native message box) is opt-in: it leans on timing nobody
  has promised. What is missing is a *slicing finished* event where UI calls
  are legal.
- **G-code is the only artifact available.** Post-processing runs on a
  temporary working copy before export, so there is no project `.3mf` and no
  `.gcode.3mf` bundle at that moment. The settings that produced the file are
  read live from the preset bundle instead and sent as metadata.
- **No structured slice result.** Print time and filament use are read from the
  G-code footer server-side. An API for the numbers OrcaSlicer already computed
  would remove that parsing entirely.
- The step can fire more than once per slice (file export and upload each get
  their own working copy). The plugin de-duplicates on the artifact path and
  size, and repeat pushes of the same plate replace that file server-side
  rather than piling up revisions.
- **The hook sees one plate, never the project.** For Bambu printers it is
  handed each plate's G-code as that plate finishes; there is no seam that
  hands over the multi-plate project. So a per-plate push is stored *alongside*
  the model's file as `<name>_plate_<n>.gcode`, and updating the model's own
  file means exporting **all plates** as one `.3mf` and pushing that from the
  *Exported files* list — see below.
- **The output name is a lie on Bambu printers.** `ctx.output_name` is the same
  temp path as the artifact (`.<pid>.<counter>.gcode`, and the counter is a
  global allocation counter, not the plate index), so the plugin derives the
  name from the catalogue file the project came from instead.

Pushing a group sends it as one **batch**: the server records a single version
for the lot instead of one per plate, which would otherwise evict a model's real
history in a single *Slice all* (versions are capped per model).

## Multi-plate projects

A catalogue model is usually one `.3mf` holding several plates; the hook only
ever sees one plate's G-code. The two outcomes:

| What you push | What happens |
|---|---|
| A single plate's G-code (what the hook captures) | Added next to the model's file as `<name>_plate_<n>.gcode`. Useful when you want the exact G-code you printed; it does not update the project. |
| **Export all plates sliced file** → one `.gcode.3mf` | Pushed from the *Exported files* list, it **replaces the model's own file and keeps its name**, and the per-plate predictions inside it are read for every plate. This is the one that keeps the catalogue's copy current. |

The plugin tells the server which file a push revises (`replaces=<fileId>`, the
file the model was resolved from), which is what makes the second row keep the
original name — the slicer's own name for the artifact is a temp path. The
server only honours it within the same artifact family, so a `.gcode` can never
take over a `.3mf` row.

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
question and cannot see which project is open, so it matches the sliced file by
name alone and pushes only when exactly one model matches (`--model <id>`
overrides). It never fails a print — every error path exits 0 unless you pass
`--strict`, which is what you want while setting it up.
