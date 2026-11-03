# MCP server (LLM access to the catalog)

*Read before touching `/api/mcp`, the MCP tools, or the OAuth provider wiring. Update in the same PR that changes this behaviour.*

Issue #96. People were copying BOMs, descriptions, manuals and slicer estimates out of the app by hand to ask an LLM "which material should I print this in", "does it need supports", "what do the parts cost", "how long will this take". All of that is already in the database, so the app serves it directly: a remote **MCP** server at `POST /api/mcp` with read-only tools, for Claude Desktop/Code and anything else that speaks the protocol.

## Off by default

`ENABLE_MCP=true` gates *everything*: the BetterAuth plugins, `/api/mcp`, the discovery documents, and the `/mcp/*` pages (each 404s otherwise). This is not just tidiness — enabling it turns the instance into an OAuth **authorization server**, and its client-registration endpoint (`/api/auth/oauth2/register`, RFC 7591) is unauthenticated by design, because that is how an LLM client bootstraps itself before anyone has signed in. An instance that doesn't want the feature shouldn't expose that write surface.

## What the tools return, and what they deliberately don't

`src/lib/mcp/tools.ts` — `search_models`, `get_model`, `get_model_bom`, `get_model_print_files`, `get_model_documents`, `read_document`, `get_document_images`. Metadata, plus the contents of PDFs.

- **No mesh bytes.** `.3mf`/`.step` geometry is useless to a language model and answers none of the target questions.
- **No scraped prices, no assembly-time field.** Each BOM item carries its vendor link and each document a fetchable URL; a client with web access reads those better than per-vendor parsing here would, and both would rot.
- **Model page URLs everywhere**, built from `BETTER_AUTH_URL` (`src/lib/app-url.ts`) — never from the request, which behind a proxy is the internal bind address. The model needs to be able to cite where a fact came from.
- `search_models` compiles its filters with the **smart-collection rule compiler** (`ruleTreeToSql`), so MCP filtering behaves like the app's own saved searches, typo-tolerant trigram text match included. Like every other listing it filters `deleted_at IS NULL`.
- `get_model_print_files` skips generated OpenSCAD variants: they are parameter-specific renders of a file that is already listed, and counting them would double the totals.
- `get_model_documents` hands out **signed file-token URLs** (`src/lib/file-token.ts`) so the client can fetch the PDF itself without a cookie. Anyone holding such a URL can read that one file until it expires — the same trade the image optimizer already makes, now aimed outward on purpose. **`robots.ts` explicitly allows `/api/files/`**: a *disallow* there makes a policy-abiding fetcher (a client's "open this link" step, not the MCP tool calls themselves — those aren't robots.txt-gated) refuse the URL outright, while a human clicking the same link never consults robots.txt and sees nothing wrong. `robots.ts` carries **no disallow at all** otherwise: the auth gate (`proxy.ts`) is what actually keeps a crawler out, so there was nothing left for a blanket `Disallow: /` to protect.

## Documents are served as content, not as links

**A URL is not a delivery mechanism for an LLM client.** `downloadUrl` alone was not enough, and the reason is worth writing down because it looks exactly like an infrastructure bug and isn't one: claude.ai's `web_fetch` will only follow URLs that came from the user's own message or from `web_search` results. A URL that appeared *only* in an MCP tool result is not in that set, so it comes back **"Failed to fetch"** — with a permissive `robots.txt`, no WAF, no CrowdSec decision, and the file fetching fine by `curl` from the same network. This was investigated end to end (2026-07-28): Anthropic's own fetcher pulls the file happily, and the giveaway was that an unrelated public site failed in the identical way in the same conversation. **Don't debug the reverse proxy when a client reports this.**

So the content travels over the MCP channel instead, on the connection the client is already authenticated on:

- **`read_document`** returns extracted text, whole pages at a time, capped by `MAX_RESPONSE_CHARS` in `src/lib/mcp/pdf-text.ts`. That budget is halved in practice because `toolResult` serializes every payload *twice* (text block + `structuredContent`), and has to clear both client caps: ~150k characters on claude.ai/Desktop before a result spills to the sandbox filesystem, and 25k tokens in Claude Code (`MAX_MCP_OUTPUT_TOKENS`). Callers page with `nextStartPage`.
- **`get_document_images`** returns a page's figures as MCP `image` content blocks. Text alone is often the *smaller* half of a manual — the document this was built against extracts 24 pages of text totalling ~12k characters (page 1 is literally `1USER MANUAL`) while every wiring and orientation detail lives in the pictures.

Both parse with **unpdf** (a serverless pdf.js build), imported lazily since no other tool needs it, and always with `verbosity: 0` — pdf.js reports missing fonts straight to `console`, which this codebase doesn't do.

### Picking figures out of page furniture

`src/lib/mcp/pdf-images.ts`. A page's embedded images include the header logo and footer mark, which are noise. The trap: **pdf.js object keys are not stable across pages**, so the obvious dedupe silently half-works. In the reference manual the 219x32 logo is globally cached and keeps `g_d0_img_p1_2` on every page, while the 474x120 banner beside it is re-keyed per page (`img_p6_2`, `img_p12_2`, `img_p16_2`) though it is the same picture. Repetition is therefore matched on **exact width x height** (`imageSignature`): furniture is pixel-identical by construction, real figures are not (that document's diagrams are 1638x1158, 1625x1149, 1583x890 — no two alike). Keys are still right for spotting the same figure painted twice *within* one page.

Only a sample of other pages is checked (`samplePagesForRepeats`) — boilerplate is on nearly every page, and decoding every image in the file to answer a question about one page would be absurd. Figures are re-encoded with **sharp** (raw pixels → WebP, longest edge 1200, alpha flattened onto white so line art doesn't render as black), which turns a 17 MB raw buffer into ~50 KB.

Support material (`printerInfo.usesSupport`) was added for this: the key was parsed out of the embedded slicer config and thrown away. **It is only filled in when a file is parsed**, so files uploaded before this change keep their stored `printer_info` and report `usesSupport: null` ("the config didn't say") until they are re-uploaded or re-synced. There is no backfill — it would mean re-reading every `.3mf` from S3.

## The transport is hand-written

`src/lib/mcp/protocol.ts` implements MCP's Streamable HTTP transport directly, rather than pulling in the SDK plus an adapter. A tools-only, read-only server needs a small slice of it and this way the whole contract stays unit-tested (`protocol.test.ts`) instead of hiding behind a dependency:

- **POST only, `application/json` responses.** The spec allows a single JSON response instead of an event stream; `GET`/`DELETE` answer **405** (not 404 — the endpoint exists, it just offers no stream to open).
- **Stateless** — no `Mcp-Session-Id`. Nothing has to survive between requests, which a self-hosted app with no shared store would otherwise need.
- A tool returning `ImageResult` gets its images appended to `content` as MCP `image` blocks, after the JSON text block. `structuredContent` deliberately stays pure JSON: a base64 blob in there reaches the model as characters to read rather than as an image to look at. It is a distinct class rather than a magic key so a tool's own payload can never be mistaken for one.
- Notifications (no `id`) get an empty **202**, including the `notifications/initialized` every client sends after the handshake.
- `initialize` echoes the client's protocol version when it is one we support, else answers with our newest.
- Error mapping matters for how the conversation continues: a `ToolError` ("no such model") comes back as a tool result with `isError`, which the model can read and act on; malformed arguments are a protocol fault (`-32602`); an unexpected exception is reported through `reportError` and answered generically, so a DB error message never reaches the model.

## Auth: OAuth tokens instead of cookies

BetterAuth 1.7 dropped the built-in `mcp` plugin this was first built on. The server now runs on **`@better-auth/mcp`** (on `@better-auth/oauth-provider`) plus the **`jwt`** plugin (`src/lib/auth.ts`), ported from Bin Vault (`~/code/bom_mgmt`), which made the same move first:

- **Access tokens are JWTs**, signed with the key in `jwks` and audience-bound to the `/api/mcp` resource. `requireMcpAuth` verifies them by signature against `/api/auth/jwks`; the user is `claims.sub`. They can't be revoked early, so they live **15 minutes** (`accessTokenExpiresIn`); the 30-day refresh token is the actual connection. A token grants **what its user sees in the browser**: the whole catalog, read-only — the catalog isn't partitioned further ([auth-and-access](./auth-and-access.md)), so there is nothing finer to scope.
- **Tables** (`src/db/schema.ts`, migration `0031_better_auth_1_7.sql`) were cross-checked against `npx auth@<version> generate` output, which is the authoritative schema for a Drizzle project (the upgrade guide's advice). The adapter looks models and fields up **by name**, and BetterAuth checks the `schema` map in `src/lib/auth.ts` against the plugins at startup — every model must be listed there, including `oauthResource`/`oauthClientResource`. **After bumping better-auth, re-run the generator and diff.** The 1.6 tables were dropped, not migrated: their opaque tokens can't become JWTs, and the clients registered themselves, so they reconnect.
- **Registration** needs both `allowDynamicClientRegistration` and `allowUnauthenticatedClientRegistration`. Client ID Metadata Documents (`@better-auth/cimd`, which the upgrade guide composes in) are not enabled yet: they need an app-owned outbound fetcher for client metadata URLs — a new SSRF surface to guard — and today's clients still register dynamically.
- **Discovery.** The issuer is `{origin}/api/auth`, so RFC 8414 metadata lives at `/.well-known/oauth-authorization-server/api/auth` (plus the `openid-configuration` twin; both optional catch-alls also answer the bare path). Protected-resource metadata (`/.well-known/oauth-protected-resource/api/mcp`) is built in the mcp plugin's request hook, so that route forwards to `auth.handler`. The proxy (`src/proxy.ts`) skips `/.well-known` — a client reads these before it holds any credential.

### Login and consent

- **`loginPage` = `/mcp/authorize`.** Authorize redirects there (with a signed query) when there's no session. The proxy bounces a signed-out visitor through the normal `/sign-in` (password or SSO) with that URL as callback; back with a session, the page checks the signature and re-issues the original authorize request minus the signature fields, `prompt=login` and `max_age` (`src/lib/mcp/oauth-query.ts`, unit-tested). This keeps the sign-in forms unaware of OAuth instead of installing BetterAuth's client plugin, which rewrites every sign-in request; the trade-off is that a forced re-login is honoured only as "has a session".
- **`consentPage` = `/mcp/consent`.** Shows the client's self-asserted name and, more usefully, where the code will be sent, then calls `auth.api.oauth2Consent` from a server action; the browser follows the returned URL client-side (CSP `form-action 'self'` would block a cross-origin form redirect). It is a **transparency screen, not a permission boundary**: approval grants what the user can see in the app. The control that matters is `ENABLE_MCP`.

## Connected clients in Settings

`/settings/mcp` (hidden from the nav, and 404 for a direct hit, unless `ENABLE_MCP`) is the other half of the story: the OAuth flow can only ever *grant*, so without a page like this an approval is permanent short of editing the database. `listMcpClients`/`revokeMcpClient` (`src/lib/mcp/clients.ts`) group consents and refresh tokens **by client** — every refresh adds rows, and a person thinks "Claude is connected", not in tokens. Disconnecting deletes that user's refresh tokens, access-token rows and consent for that client; the access token already issued is a self-contained JWT and keeps working until it expires (≤ 15 min). The `oauth_client` registration stays — dynamic registration isn't per-user, so another user may still be connected through it.

## Verifying a change

Unit tests cover the wire contract; the OAuth handshake and the tools need a running app (see the `verify` skill). The whole flow is curl-driveable: `POST /api/auth/oauth2/register` → `GET /api/auth/oauth2/authorize?…&resource=…/api/mcp` (PKCE) → `/mcp/authorize` → `/mcp/consent` → `POST /api/auth/oauth2/consent {accept, oauth_query}` (with an `Origin` header — BetterAuth's CSRF check) → `POST /api/auth/oauth2/token` → `POST /api/mcp` with the bearer token. A script doing `fetch` gets `{redirect, url}` JSON instead of 302s from the authorize endpoints (BetterAuth treats it as an XHR); curl gets redirects.
