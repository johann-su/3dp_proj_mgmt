# Parametric OpenSCAD models

*Read before touching the `.scad` customizer, preview, or variant generation.
Update in the same PR that changes this behaviour.*

A model can carry its `.scad` source as a model file (uploaded, or imported —
Printables serves `.scad` anonymously via its `otherFiles` group; MakerWorld's
comes through `GET
api.bambulab.com/v1/design-service/design/{id}/model?modelType=all&type=download`,
undocumented and Bambu-login-gated like profile downloads; only `modelType=all`
exists ("scad"/"3mf" answer 404) and it returns one zip of every raw file, from
which staging extracts just the `.scad` entries).

`.scad` files get a "Customize" button on the model page (any signed-in viewer)
linking to a full-page customizer (`/models/{id}/customize/{fileId}`): a
parameter rail built from the OpenSCAD customizer comments in the source —
parsed by the pure `src/lib/scad-params.ts` (the design API's `scadConfig` field
is empty in practice, so the source is the only schema; `/* [Hidden] */` stays
hidden, unrecognized annotations degrade to plain inputs) — beside a live
three.js preview (plain `three`, no react-three-fiber; renders on demand, no rAF
loop) fed by `POST /api/models/{id}/customize/preview`, which returns ephemeral
**binary STL** (the service's second output format; nothing is stored, the
client debounces changes and drops stale responses via a sequence counter).

"Generate .3mf" (any signed-in user — variants land on the model like a shared
render, deletable by their generator or the owner; `POST
/api/models/{id}/customize`) renders through the **openscad service**
(`openscad/`, fourth compose container: zero-dependency wrapper around the
OpenSCAD CLI, Debian package + vendored pinned BOSL2/MCAD under `OPENSCADPATH`)
and **stores** the result as a `model_files` row flagged `generated_from_id` +
`generated_params` — stored rather than streamed back because only stored files
get slice estimates and slicer deep links. Identical parameter sets dedupe via
`generated_params_hash`; variants are capped at 20 per source, render nested
under the `.scad` card, and are deletable (DELETE on the same route). Renders are
normalized by `normalizeThreeMf` (OpenSCAD centers on the origin like Onshape).

Security: values only travel via OpenSCAD's `-p` parameter-set JSON (never
`-D`/CLI), `coerceScadValues` clamps them against the parsed schema, and
`findForbiddenFileRefs` rejects `import()`/`surface()` and any `include`/`use`
outside the bundled libraries (multi-file projects are unsupported — keep
`SCAD_LIBRARY_ALLOWLIST` in sync with the Dockerfile). The service itself runs
non-root with a hard timeout and compose memory/pid limits (CGAL happily eats
unbounded RAM). Optional like the slicer: without `OPENSCAD_URL` the customizer
UI is hidden and `.scad` files are plain downloads.
