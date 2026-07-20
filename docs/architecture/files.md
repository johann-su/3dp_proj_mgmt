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
