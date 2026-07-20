# Onshape integration

*Read before touching Onshape import/sync or the API client. Update in the same
PR that changes this behaviour.*

Code lives in `src/lib/onshape/` (API client, OAuth, credentials) and
`src/lib/import/onshape.ts` (importer); the sync endpoint is
`src/app/api/models/[id]/onshape-sync/route.ts`.

> Operator setup (registering the OAuth app, env vars, troubleshooting) is a
> separate, user-facing doc: [`docs/onshape.md`](../onshape.md).

## Auth & import flow

`src/lib/onshape/`, `src/lib/import/onshape.ts` authenticates with OAuth2
("Sign in with Onshape", the flow behind
[passport-onshape](https://github.com/onshape/passport-onshape), implemented
directly in `src/lib/onshape/oauth.ts`): the self-hoster registers one OAuth app
at dev-portal.onshape.com (redirect URL `{BETTER_AUTH_URL}/api/onshape/callback`,
read documents + profile scopes) and sets
`ONSHAPE_CLIENT_ID`/`ONSHAPE_CLIENT_SECRET`; users then connect under
**Settings → Onshape** via consent screen — no API keys to copy. Access +
refresh tokens are stored encrypted at rest like the Bambu token, access tokens
are refreshed transparently (~60 min lifetime, rotated refresh tokens), and a
connection that can no longer be refreshed is dropped so the user simply
reconnects.

Importing a `cad.onshape.com/documents/…` URL first answers with the document's
Part Studio/Assembly tab list (`needsOnshapeSelection`, the same round-trip
pattern as the many-files confirm) and the import form shows a tab-selection
dialog: **Part Studios are preselected, Assemblies are not**, because Part
Studios hold the printable geometry while an assembly export places parts at
their mated positions (an interlocking design — lid inside box — comes out
overlapping and slices as fused). The URL's `/e/{eid}` is just whichever tab was
open when the link was copied, so it only gets a "linked tab" badge, not
authority; an explicit selection always beats the pin (`selectExportElements` in
`src/lib/onshape/api.ts`, unit-tested). The dialog also carries a
**branch/version dropdown** (workspaces first, then versions newest-first —
`branchChoices`, which drops the implicit root "Start" version every document
has) whenever the document offers more than one; picking one re-requests the tab
listing (each branch has its own tabs) and the pick overrides the URL's /w|v/
pin for the export and the stored `sourceUrl` — importing a version yields an
immutable snapshot that "Sync from Onshape" reports as always up to date.
Documents with one tab and no branch choice skip the dialog. Each chosen tab
(capped at `MAX_EXPORT_ELEMENTS`, surfaced in the dialog) runs an asynchronous
3MF export into its own file — see the API details below. The resulting `.3mf`
files stream to S3 like any other asset and get slice estimates like regular
uploads.

The canonical document URL is stored as the model's `sourceUrl` (doubling as the
"Edit in Onshape" link) together with the workspace microversion; "Sync from
Onshape" (any signed-in user — syncing counts as editing, per the
collaborative-editing rule; `POST /api/models/{id}/onshape-sync`) compares the
current microversion and re-exports **the tabs the model was imported with** (the
distinct `model_files.onshape_element_id` values, falling back to the URL pin
when none remain), replacing the previously imported files; a tab deleted in
Onshape is dropped with a warning, since the pre-sync state becomes a version.
Sync is two-phase like the MakerWorld/Printables source sync: a body-less POST
is the preview, and when the document has eligible tabs the model doesn't carry
(checked even when the microversion is unchanged, so a previously declined tab
stays addable), it answers `needs-selection` with the new tabs and the button
opens a picker (import-dialog defaults); re-POSTing with the chosen
`addElementIds` (empty = decline) exports imported + added tabs together. This
picker is the only way to add upstream tabs to an existing model without
re-importing it.

## API details

Things to know before touching it:

- **Auth**: every call needs the user's OAuth2 Bearer token (no anonymous API).
  Invalid tokens don't always 401 — `/users/sessioninfo` answers 204 as an
  anonymous session, so only a 200 counts as authenticated.
- **Exports are async translations**: start one, poll `GET /translations/{id}`
  until `requestState` leaves `ACTIVE`, then download from
  `GET /documents/d/{did}/externaldata/{fid}` using `resultExternalDataIds`.
  Poll with backoff (Onshape rate-limits).
- **Format-specific export routes exist only for glTF, OBJ, and STEP**
  (`POST …/export/step` etc.). Every other format — including the 3MF we export
  — must go through the generic
  `POST /{partstudios|assemblies}/d/{did}/{wv}/{wvid}/e/{eid}/translations` with
  `formatName` in the body. Hitting a nonexistent route like `…/export/3mf`
  returns 404, which `onshapeFetch` surfaces as the misleading "Document not
  found" error. See `buildExportRequest` in `src/lib/onshape/api.ts` and
  <https://onshape-public.github.io/docs/api-adv/translation/>.
- **Mesh formats need tessellation detail parameters**: translations to mesh
  formats (3MF, STL, …) must include a `resolution` preset
  (`fine|medium|coarse`, lowercase) — or custom `angularTolerance` /
  `distanceTolerance` / `maximumChordLength` values — plus the `unit`, or the
  translation starts fine but then FAILs with "Invalid 3MF detail parameters
  were specified". CAD formats like STEP don't take these. The full request
  schema is `BTTranslateFormatParams` in `cad.onshape.com/api/openapi`.
- **We export 3MF only** so the headless slicer can slice the result; the legacy
  STEP export path was removed on purpose — don't reintroduce it.
- **Onshape 3MF exports are in meters, centered on the origin** — the `unit`
  request parameter does not change the written file (`unit="meter"` with
  meter-scale coordinates). That is spec-valid 3MF, but PrusaSlicer, Bambu Studio
  and OrcaSlicer ignore the 3MF `unit` attribute (coordinates are read as mm → a
  25 mm part becomes 0.025 mm) and reject geometry at negative X/Y as "outside of
  the print volume". Every staged Onshape export therefore runs through
  `normalizeThreeMf` (`src/lib/threemf-normalize.ts`), which rescales the model
  to millimeters and moves the build onto the plate (XY center at 128 mm, lowest
  point at z=0) — keep that in place for any new code path that stores Onshape
  exports.
- **Part Studios vs Assemblies** use different URL resources
  (`partstudios` / `assemblies`) but the same request shape; pick by
  `elementType`.
- **URL pins**: document URLs are `…/documents/{did}/{w|v|m}/{wvmid}[/e/{eid}]` —
  `w` workspaces are syncable, `v` versions are immutable snapshots, `m`
  microversions are rejected at import (not exportable via the w/v endpoints).
- **Branches/versions**: `GET /documents/d/{did}/workspaces` and `…/versions`
  (BTWorkspaceInfo/BTVersionInfo: `id`, `name`, `parent`, `createdAt`) feed the
  import dialog's dropdown. Every document has an implicit root version named
  "Start" with `parent: null` — the empty initial state; `branchChoices` filters
  it on `parent == null && name === "Start"` (both conditions, so a missing
  `parent` field or a user version named "Start" can't be dropped by mistake).
- Don't trust remembered endpoint shapes; verify against
  `cad.onshape.com/api/openapi` or the docs below before changing API calls.

## Documentation sources

- [Onshape API](https://onshape-public.github.io/docs/api-intro/)
- [Onshape import/export (translations)](https://onshape-public.github.io/docs/api-adv/translation/)
