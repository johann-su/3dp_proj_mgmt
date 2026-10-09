# Uploads, downloads & file tokens

*Read before touching upload/download routes, image rendering, file tokens or
the storage backends. Update in the same PR that changes this behaviour.*

## Storage backends

File bytes live behind the `BlobStore` interface (`src/lib/blob-store.ts`):
`put` / `get` (optionally a byte range) / `delete`, by key. Two
implementations — `S3BlobStore` (`blob-store-s3.ts`) and `FsBlobStore`
(`blob-store-fs.ts`, a directory such as a Docker volume) — picked by
`STORAGE_BACKEND` through `resolveStorageConfig`. **Nothing outside those
files may touch a backend directly**: go through `blobStore()` in
`src/lib/storage.ts` (or the helpers there and `deleteS3Keys`). The store is
built on first use, not at import, so importing storage code has no side
effects and a misconfiguration fails where files are touched.

The contract every backend must keep (and `blob-store-fs.test.ts` pins for
the filesystem one):

- **`get` returns `null` for a missing key** (the routes 404 on it) and
  throws for anything else. A range is inclusive and clamped to the object;
  `contentLength` is the length actually returned, used as the
  `Content-Length` of `206` responses.
- **A failed `put` leaves nothing readable under the key** — the filesystem
  store writes a `.partial` temp file and renames it into place.
- **`delete` is idempotent** — versioning can delete a key that's already
  gone.
- **Keys are opaque relative paths** (`uploads/<uuid>/<name>`), generated
  server-side and never renamed (snapshots reference them, see
  [versioning.md](./versioning.md)). The filesystem store still rejects any
  key that could resolve outside its root, since keys round-trip through the
  DB. The `s3_key` column / `s3Key` field predate the abstraction and hold a
  key for whichever backend is configured.

One backend per instance: there is no per-file backend column, so switching
means copying all objects under the same keys.

## Uploads

Uploads stream through `POST /api/upload` to storage (no browser↔S3 CORS setup
needed); only signed-in users can upload, and file extensions are validated
server-side. Kinds are `model`, `image`, `pdf` and `video`; **`image` and
`video` are one gallery group** (`GALLERY_KINDS`, `src/lib/file-kind.ts`) —
they share the model's `position` sequence, either can be the cover, and any
new cover query must select both (`inArray(f.kind, GALLERY_KINDS)`), not
`kind = "image"`. The `kind` column is plain text, so adding a kind needs no
migration. Stored content types are always derived from the allowlisted
extension (`contentTypeForFilename`), never from a client header/value —
`/api/files` serves images inline on our origin, so an uploader-chosen
`text/html` would be stored XSS. File routes also send
`X-Content-Type-Options: nosniff`.

`stageStream`/`stageBuffer` (`src/lib/storage.ts`) return a **SHA-256
`contentHash`** alongside the size, both derived from the bytes as they stream
to storage so the object never has to be read back. `createModel`/`updateModel`
store it on `kind: "model"` rows only (`model_files.content_hash`) — images and
PDFs are legitimately shared between models — and use it to flag re-uploaded
files as duplicates (see
[`import.md`](./import.md#duplicate-detection)). Like `size`, the value
round-trips through the client, so it is re-validated as 64-char lowercase hex
on the way in; it is a dedup hint, not a trust boundary.

## Downloads & images

Downloads and images stream from storage through `GET /api/files/[id]`, so the
storage backend never needs to be reachable from the browser. Both file routes
**answer byte-range requests** (`src/lib/http-range.ts` parses the header, the
route passes it to the blob store and replies `206` + `Content-Range`, or `416` for a start
past the end): a `<video>` seeks by range, and Safari refuses to play a source
whose server doesn't do this at all. Ranged responses are deliberately *not*
counted as downloads — one scrub would otherwise register dozens. The route accepts a
session cookie (browser links/downloads) **or a signed file token**
(`src/lib/file-token.ts`: HMAC over file id + expiry, keyed off
`BETTER_AUTH_SECRET`, expiry bucketed to week boundaries so URLs stay
cache-stable). Tokens exist because two consumers cannot send cookies: the
next/image optimizer (its internal fetch carries no request headers) and slicer
deep links. Images therefore render from `fileSrc(id)` (`…?token=…`) — signed
server-side and passed down in the card/gallery data, since cards also render
inside client components — and deep links use the token **path** variant
`/api/files/[id]/[token]/[filename]` (Orca keeps the query string when naming
downloads, so `?token=` would corrupt the filename). `next.config.ts` must keep
`images.localPatterns` allowing `/api/files/**` with unrestricted `search`, or
Next 16 rejects the tokened srcs.

A third, anonymous variant serves public share links:
`/api/files/shared/[fileId]?share=<token>` (and its slicer-deep-link path form
`/api/files/shared/[fileId]/[token]/[filename]`) re-checks the share link and the
file's model membership on every request instead of trusting a signed file
token, so a revoked link stops serving at once (see
[auth-and-access.md](./auth-and-access.md#public-share-links)). All three
routes stream through `serveModelFile` (`src/lib/serve-file.ts`) — the range,
content-type and download-count handling lives there; each route only does
its own authorization and picks its `Cache-Control`.

## Export zip

`GET /api/models/[id]/export` bundles one model into a `.zip`: `metadata.json`
(the manifest — see below), `README.md` (title + version + description, already
Markdown source), `bom.csv` (`bomToCsv`, omitted when the BOM is empty) and the
files under `files/` (model), `documents/` (PDF) and `images/`. Session-gated
but **not** owner-gated — it is a bundle of downloads the viewer could already
fetch one by one.

`metadata.json` is what makes the archive re-importable
([import.md](import.md#archive-import)); the folder tree alone is lossy. It
carries tags, the category **name** (ids are per-instance), the BOM *with*
sections (`bom.csv` is flat), `sourceUrl`, and one entry per file with its
`kind`, its real `filename` (which differs from the entry `path` when dedupe
renamed it), its sync provenance (`imported`, `sourceFileId`,
`sourceModifiedAt`, `onshapeElementId`) and whether it is a customizer-
**generated** variant. Adding a field does **not** bump `formatVersion` — the
reader treats every field as optional, so old readers ignore what they don't
know and archives written before the manifest existed still import.

The archive is named `<title>_v<version>.zip`. That number must keep agreeing
with the History panel's numbering, which is positional over the *retained*
`model_versions` rows (the cap prunes oldest-first, and pre-versioning models
have none and display as v1) — hence `exportedVersionNumber(count)`, not a
stored version id.

The zip is built by `buildModelExportZip` (`src/lib/model-export.ts`), kept
pure so it can be unit-tested; the route only reads the bytes
(`readFileBytes`) and sets the headers. Three things it must keep doing:

- **Sanitize entry names.** `model_files.filename` is user-controlled, so a
  `../` in one would let an extractor write outside the destination ("zip
  slip"): only the last path segment survives, and `.`/`..` are replaced.
- **Dedupe per folder, case-insensitively.** Filenames aren't unique, and the
  archive gets extracted onto case-insensitive filesystems — the second
  `part.3mf` becomes `part-2.3mf` so neither overwrites the other.
- **Cap the total size** (`MAX_EXPORT_BYTES`, `413` past it). `zipSync`
  buffers the whole archive and its inputs in memory; a streaming zip is the
  fix if real models ever get close.

Exports are **live state only** — `model_files`, not `model_versions`
snapshots (see [versioning.md](versioning.md)). Re-importing one is the archive
importer's job, documented in [import.md](import.md#archive-import).
