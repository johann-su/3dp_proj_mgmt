# ScanRuler (scan measuring, mesh repair, reverse engineering)

*Read before touching the "Open in ScanRuler" links, the CORS grant on the
tokened file routes, or `.scanruler` project files. Update in the same PR that
changes this behaviour.*

[ScanRuler](https://github.com/CNCKitchen/scanruler) (CNC Kitchen) is a
browser app that measures 3D scans, cleans up and reduces meshes ("Mesh
Tools") and reverse engineers a scan into a solid STEP body. Everything runs
client-side in the user's browser.

## Licence boundary — the reason for the whole design

ScanRuler is **AGPL-3.0-only**; this project is MIT. Importing, vendoring or
bundling any of its code (or running its engine inside our Node process) would
make the combined work AGPL. So the integration stays **at arm's length**:

- **A URL**, not code: we hand the browser `SCANRULER_URL?open=<file url>&
  workspace=<id>` and ScanRuler fetches the file itself.
- **Files**, not APIs: results come back as ordinary uploads — a 3MF mesh
  (repaired scan), a STEP solid (reverse engineered) or a `.scanruler` project.
- **Our own reader** of the `.scanruler` format (`src/lib/scanruler-project.ts`)
  — a ZIP with `project.json`. Written from the file, not from their code.

Self-hosting an *unmodified* ScanRuler next to the app (point `SCANRULER_URL`
at it) is fine, same as the AGPL OrcaSlicer in `slicer/`; a *modified* hosted
copy must publish its source. "ScanRuler" and the CNC Kitchen marks are not
covered by the code licence — label links "Open in ScanRuler", never rebrand.

## Open in ScanRuler

`SCANRULER_URL` unset → no entries (degrades to off, like the other optional
services). Set → the file row's download menu (`file-download-menu.tsx`)
offers Measure / Mesh Tools / Reverse engineer for `.3mf`, `.step`/`.stp` and
`.scanruler` files (`scanRulerOpens`). Deviation isn't offered: it needs a
second (reference) file, and `?open=` carries one.

- **The URL is the tokened path route** `/api/files/<id>/<token>/<filename>`:
  ScanRuler names the opened file after the URL's last path segment and picks
  the parser by its extension.
- **Members get a short-lived token minted on click** (`scanRulerFilePath`
  server action → `shortFileToken`, 10 min), not the week-long
  `slicerFileBase` one. Unlike slicer deep links, this URL ends up in a
  *third-party web address* (history, sync, the host's access logs). Minting on
  click keeps a long-open page working. The new tab is opened synchronously
  inside the click (popup blocker), with `opener` cut, then navigated once the
  token is back.
- **Share pages reuse the share-token path** (`sharedSlicerFileBase`): it is
  re-checked per request, so revoking the link kills the ScanRuler URL too.
- **CORS**: ScanRuler `fetch`es with `mode: 'cors'`. Both `[token]/[filename]`
  routes add `Access-Control-Allow-Origin` **only** when the request's
  `Origin` equals `SCANRULER_URL`'s origin (`scanRulerCorsHeaders`), with
  `Vary: Origin`, never `Allow-Credentials`. A plain GET needs no preflight.
  The cookie-authenticated `/api/files/[id]` route never gets CORS.

## `.scanruler` projects on a model

`.scanruler` is in `MODEL_EXTENSIONS` (served as `application/zip`, always as
an attachment). A project is the editable session — the scan (embedded as
`scan.<ext>`), fitted elements, dimensions, Reverse-engineer features — so
storing it keeps the work next to the parts it produced, versioned like any
model file, and reopenable via the link above.

The file row shows "ScanRuler project · <scan> · N elements · …", read from
`project.json` with **ranged reads** (`readZipTextEntry`, shared with the 3MF
metadata reader), so a project embedding a large scan costs a few KB.
`project.json` is ScanRuler's *internal* format (`schemaVersion` 1 at 0.9.x):
every field is read defensively and anything unexpected is dropped, never an
error. Note a project duplicates its scan's bytes.

## What was ruled out (as of ScanRuler 0.9.2)

- **Server-side repair / reverse engineering.** Its headless engine
  (`scanruler-mcp --engine`) exposes only session commands and Reverse
  engineer's CAD commands *without a scan* — no scan open, no Mesh Tools, no
  Deviation. Reverse engineering is also an LLM-driven loop (~100 min, ~300
  tool calls per part), not a function. Server-side mesh cleanup, if wanted,
  should use permissive libraries directly (`manifold-3d` Apache-2.0,
  `meshoptimizer` MIT — what ScanRuler itself uses).
- **Saving back from ScanRuler.** It exports by browser download only; there
  is no callback or upload target.
- **Agent round trip.** An agent with both MCP servers can already fetch a
  `downloadUrl` from ours and open it via `scanruler-mcp` (it takes local
  paths/bytes). Bringing the result back would need a write tool on our MCP,
  which is read-only by design (see [mcp.md](./mcp.md)) — a separate decision.
