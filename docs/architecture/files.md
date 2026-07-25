# Uploads, downloads & file tokens

*Read before touching upload/download routes, image rendering, or file tokens.
Update in the same PR that changes this behaviour.*

## Uploads

Uploads stream through `POST /api/upload` to S3 (no browser↔S3 CORS setup
needed); only signed-in users can upload, and file extensions are validated
server-side. Stored content types are always derived from the allowlisted
extension (`contentTypeForFilename`), never from a client header/value —
`/api/files` serves images inline on our origin, so an uploader-chosen
`text/html` would be stored XSS. File routes also send
`X-Content-Type-Options: nosniff`.

## Downloads & images

Downloads and images stream from S3 through `GET /api/files/[id]`, so the S3
endpoint never needs to be reachable from the browser. The route accepts a
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

## Export zip

`GET /api/models/[id]/export` bundles one model into a `.zip`: `README.md`
(title + version + description, already Markdown source), `bom.csv`
(`bomToCsv`, omitted when the BOM is empty) and the files under `files/`
(model), `documents/` (PDF) and `images/`. Session-gated but **not**
owner-gated — it is a bundle of downloads the viewer could already fetch one by
one.

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
snapshots (see [versioning.md](versioning.md)). Re-importing an export is
deliberately not supported: the folder layout can't distinguish e.g. a `.scad`
source from a generated variant, so a round trip needs its own manifest
format.
