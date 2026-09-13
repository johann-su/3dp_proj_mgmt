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
> 2. You must **export** the sliced file (*Print plate ▾ → Export plate sliced
>    file*, File → Export → Export G-code, or an upload to a printer). Slicing
>    alone never reaches a plugin.
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
| `ask` (default) | Queues the slice. You answer in the plugin's own window: **Plugins → Print Vault: review & push → ▷ Run** (or put it on the Actions Speed Dial, which is one click from the plate). |
| `auto` | Pushes immediately, but only when the model is an unambiguous exact-file match and you have ticked *always* for it. Otherwise it falls back to queueing. |
| `off` | Captures nothing. |

Independent of all three, the review window lists **exported files** found in
your export folders (`~/Downloads` and `~/Desktop` by default, or set
`export_dirs`). Press *Match the open plate*, pick the model, and push — no
process preset involved. This is the path to use when you do not want a
per-profile setting, and the one that works when you forgot to add it.

`prompt_after_slice` additionally tries to raise the question by itself right
after a slice. It is **off by default and experimental** — see *Known limits*.

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
  their own working copy). The plugin de-duplicates on name and size, and
  repeat pushes of the same plate replace that file server-side rather than
  piling up revisions.

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
