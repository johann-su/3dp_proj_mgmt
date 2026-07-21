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
the 3D preview's plate at real dimensions, issue #80), which the model page
shows per file. Slicer-derived numbers
are still approximations (PrusaSlicer's time estimator, not the printer's
firmware) and shown with a `~` prefix; files PrusaSlicer cannot slice are
flagged on the model page so the uploader notices a broken or unprintable file.
Legacy `.step` files (from before Onshape imports switched to 3MF) and files
uploaded before this feature are skipped. The service is optional: without
`SLICER_URL`, unsliced files simply show no estimates and stay `pending`.

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
