# MCP server (LLM access to the catalog)

*Read before touching `/api/mcp`, the MCP tools, or the OAuth provider wiring.
Update in the same PR that changes this behaviour.*

Issue #96. People were copying BOMs, descriptions, manuals and slicer
estimates out of the app by hand to ask an LLM "which material should I print
this in", "does it need supports", "what do the parts cost", "how long will
this take". All of that is already in the database, so the app serves it
directly: a remote **MCP** server at `POST /api/mcp` with read-only tools, for
Claude Desktop/Code and anything else that speaks the protocol.

## Off by default

`ENABLE_MCP=true` gates *everything*: the BetterAuth plugin, `/api/mcp`, both
discovery documents, and the consent page (each 404s otherwise). This is not
just tidiness — enabling it turns the instance into an OAuth **authorization
server**, and its client-registration endpoint (`/api/auth/mcp/register`, RFC
7591) is unauthenticated by design, because that is how an LLM client
bootstraps itself before anyone has signed in. An instance that doesn't want
the feature shouldn't expose that write surface.

## What the tools return, and what they deliberately don't

`src/lib/mcp/tools.ts` — `search_models`, `get_model`, `get_model_bom`,
`get_model_print_files`, `get_model_documents`. Metadata only.

- **No mesh bytes.** `.3mf`/`.step` geometry is useless to a language model and
  answers none of the target questions.
- **No scraped prices, no assembly-time field.** Each BOM item carries its
  vendor link and each document a fetchable URL; a client with web access
  reads those better than per-vendor parsing here would, and both would rot.
- **Model page URLs everywhere**, built from `BETTER_AUTH_URL`
  (`src/lib/app-url.ts`) — never from the request, which behind a proxy is the
  internal bind address. The model needs to be able to cite where a fact came
  from.
- `search_models` compiles its filters with the **smart-collection rule
  compiler** (`ruleTreeToSql`), so MCP filtering behaves like the app's own
  saved searches, typo-tolerant trigram text match included. Like every other
  listing it filters `deleted_at IS NULL`.
- `get_model_print_files` skips generated OpenSCAD variants: they are
  parameter-specific renders of a file that is already listed, and counting
  them would double the totals.
- `get_model_documents` hands out **signed file-token URLs**
  (`src/lib/file-token.ts`) so the client can fetch the PDF itself without a
  cookie. Anyone holding such a URL can read that one file until it expires —
  the same trade the image optimizer already makes, now aimed outward on
  purpose.

Support material (`printerInfo.usesSupport`) was added for this: the key was
parsed out of the embedded slicer config and thrown away. **It is only filled
in when a file is parsed**, so files uploaded before this change keep their
stored `printer_info` and report `usesSupport: null` ("the config didn't say")
until they are re-uploaded or re-synced. There is no backfill — it would mean
re-reading every `.3mf` from S3.

## The transport is hand-written

`src/lib/mcp/protocol.ts` implements MCP's Streamable HTTP transport directly,
rather than pulling in the SDK plus an adapter. A tools-only, read-only server
needs a small slice of it and this way the whole contract stays unit-tested
(`protocol.test.ts`) instead of hiding behind a dependency:

- **POST only, `application/json` responses.** The spec allows a single JSON
  response instead of an event stream; `GET`/`DELETE` answer **405** (not 404 —
  the endpoint exists, it just offers no stream to open).
- **Stateless** — no `Mcp-Session-Id`. Nothing has to survive between requests,
  which a self-hosted app with no shared store would otherwise need.
- Notifications (no `id`) get an empty **202**, including the
  `notifications/initialized` every client sends after the handshake.
- `initialize` echoes the client's protocol version when it is one we support,
  else answers with our newest.
- Error mapping matters for how the conversation continues: a `ToolError` ("no
  such model") comes back as a tool result with `isError`, which the model can
  read and act on; malformed arguments are a protocol fault (`-32602`); an
  unexpected exception is reported through `reportError` and answered
  generically, so a DB error message never reaches the model.

## Auth: OAuth tokens instead of cookies

BetterAuth's `mcp` plugin (`src/lib/auth.ts`) mounts `/api/auth/mcp/*` and owns
the three `oauth_*` tables in `src/db/schema.ts` — whose **property names must
stay exactly as spelled**, since its drizzle adapter looks models and fields up
by name. `withMcpAuth` guards the route: it resolves the bearer token and
answers 401 with the `WWW-Authenticate: resource_metadata=…` header that tells
a client where to go. A token grants **what its user sees in the browser**: the
whole catalog, read-only. The catalog isn't partitioned further
([auth-and-access](./auth-and-access.md)), so there is nothing finer to scope.

Two pieces of the flow are ours rather than BetterAuth's, for one reason each:

1. **`/.well-known/oauth-authorization-server` overrides
   `authorization_endpoint`** to point at our consent page instead of
   `/api/auth/mcp/authorize`. Both discovery documents are served at the origin
   root because that is the issuer the plugin advertises
   (`authorization_servers: [origin]`); the protected-resource document is also
   served under `/api/mcp` (RFC 9728's derived location) and by BetterAuth
   under its own base path — all three return the same thing, so whichever a
   client picks agrees with the others. `resource` is pinned to the `/api/mcp`
   URL: a client that checks the metadata against the server URL it was given
   would otherwise refuse the token.

2. **`/mcp/authorize` (`src/app/mcp/authorize/page.tsx`) shows who is asking**
   before forwarding the untouched OAuth query to BetterAuth. Beyond
   transparency this avoids a broken path: BetterAuth's own endpoint, when it
   finds no session, stashes the request in a cookie and resumes it after the
   *next* sign-in — which for our email form means replying to its `fetch` with
   a cross-origin 302 the browser follows and the form reads as a failed login,
   burning the authorization code on the way. Our page never reaches that
   endpoint without a session, so that path stays dormant. It is a
   **transparency screen, not a permission boundary**: a signed-in user can
   still be linked straight to BetterAuth's endpoint, so it cannot stop a
   crafted authorize link. The control that matters is `ENABLE_MCP`.

The proxy (`src/proxy.ts`) skips `/.well-known` — a client must read those
documents before it holds any credential.

## Connected clients in Settings

`/settings/mcp` (hidden from the nav, and 404 for a direct hit, unless
`ENABLE_MCP`) is the other half of the story: the OAuth flow can only ever
*grant*, so without a page like this an approval is permanent short of editing
the database. `listMcpClients`/`revokeMcpClient` (`src/lib/mcp/clients.ts`)
group `oauth_access_token` rows **by client** — a refresh or a re-approval adds
rows, and a person thinks "Claude is connected", not in tokens. Disconnecting
deletes that user's tokens for that client (revocation is immediate: the route
resolves every request against these rows) plus any consent rows, but leaves
the `oauth_application` registration alone — dynamic registration isn't
per-user, so another user may still be connected through it.

## Verifying a change

Unit tests cover the wire contract; the OAuth handshake and the tools need a
running app (see the `verify` skill). The whole flow is curl-driveable:
`POST /api/auth/mcp/register` → open `/mcp/authorize?…` with a session cookie →
follow the `Allow` link to `/api/auth/mcp/authorize` → exchange the code at
`/api/auth/mcp/token` with the PKCE verifier → call `/api/mcp` with the bearer
token.
