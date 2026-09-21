<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Testing

Unit tests run on Node's built-in test runner (`node:test` + `node:assert/strict`)
via `tsx` — there is no Vitest/Jest. Run the whole suite with `npm test`, which
covers `src/**/*.test.ts` plus the slicer service's `slicer/*.test.mjs`.

One test is not Node's: the OrcaSlicer plugin is Python, and the project merge
at the heart of slice-push is pure logic over 3MF archives, so it is checked by
`python3 orca-plugin/assemble.test.py` (stdlib only, no slicer and no instance).
CI runs it next to `npm test`; run it yourself after touching
`orca-plugin/orca_print_vault_plugin_any.py`.

## What the suite is for

This is a young, fast-moving project where most changes land through AI agents.
The suite exists to answer one question: **"did this change break a behaviour
that already worked?"** — and to double as executable documentation of the
tricky, non-obvious contracts (Onshape's meters-not-mm exports, Bambu's
double-escaped HTML, AMS extruder selection, the ZIP-tail ranged reads). Aim
for tests an agent can read to *learn the contract*, not tests that pin down an
implementation.

Write tests that:

- **Assert on observable behaviour**, not internal structure. Check the parsed
  result, the translated config, the round-tripped CSV — not which private
  helper ran or how many times. A refactor that preserves behaviour should keep
  the tests green; that's the whole point.
- **Cover the contract's edges**, since those are where regressions hide and
  where the documentation value is highest: the fallback branch, the hostile
  input that must be rejected, the multi-plate sum, the look-alike host. One
  crisp test per real behaviour beats ten that restate the same path.
- **Name the behaviour and its "why."** The test title and a one-line comment
  should tell an agent *why* the case exists ("percent is allowed only for
  fill_density", "objects on extruder 2 → second filament"), so a future change
  that trips it knows whether it broke something or changed a documented rule.

Avoid: snapshotting large blobs, asserting exact error strings (assert that it
*errored*, or match a stable substring), re-testing a third-party library's
behaviour, and duplicating one function's cases across several files.

## Conventions

- Co-locate tests next to the code as `*.test.ts` (e.g. `src/lib/format.ts` →
  `src/lib/format.test.ts`). Slicer-service tests are `*.test.mjs` next to
  `slicer/server.mjs`.
- Import from source with the `@/` alias; `tsx` resolves it from `tsconfig.json`.
- Prefer **pure logic** (URL parsers, formatters, BOM/CSV, crypto round-trips,
  the ZIP/config parsers). Do not import modules with load-time side effects
  into a test — e.g. `@/lib/s3` builds an S3 client from env, `@/db` opens a
  pool. Extract the pure core and test that: `threemf-slice-info.ts` holds the
  parsing (unit-tested) while `threemf-remote.ts` only wires it to S3, and the
  slicer's `lib.mjs` holds the parsing/translation while `server.mjs` does I/O.
  Follow that split when a new feature mixes logic with a client.
- No DB or network in unit tests. If a function needs bytes, build them in
  memory (fflate's `zipSync` makes a `.3mf`/ZIP fixture) or inject the reader
  (see `RangeReader` in `threemf-slice-info.ts`); stub `fetch` for HTTP paths.
  The full import/estimate HTTP flows and DB actions stay manual/integration —
  use the `/verify` or `/run` skills to exercise them against a running app.

Example:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "@/lib/format";

test("formatDuration splits hours and minutes", () => {
  assert.equal(formatDuration(5460), "1 h 31 min");
});
```

# Code organization

Rules of thumb for keeping files comprehensible as features grow. These are
judgment calls, not hard limits — they follow the React docs' advice (don't
extract prematurely, but a long list of useState/useEffect serving separate
concerns is the signal to untangle) and Next.js's colocation conventions.

- **Keep the existing layout**: route-specific components sit next to their
  route under `src/app/…` (colocation is safe — only `page`/`route` files are
  routable), shared components in `src/components`, non-React logic in
  `src/lib`. Next.js is deliberately unopinionated here; the value is
  consistency, so don't introduce `_components`/`hooks` folder schemes.
- **Split on unrelated concerns, not on line count.** A long file whose state
  and handlers all serve one feature (`bom-editor.tsx`, `rule-builder.tsx`)
  is easier to work on than the same code spread across ten files — jumping
  between many small files costs comprehension too. The smell that warrants a
  split is *distance*: state declared hundreds of lines from its only use,
  several self-contained subtrees each with their own useState/useEffect
  cluster, or sub-components you must scroll past to reach the one you came
  to edit. When adding a feature would push a file past that point, split
  first, then add.
- **Cut along state boundaries.** A subtree that owns its own state and talks
  to its parent through a narrow prop interface moves out cleanly
  (`model-form-pickers.tsx`, `model-file-cards.tsx`); a subtree that reads
  half the parent's state should stay inline. Prefer moving the exported
  types with the components and re-exporting from the old module so
  consumers don't churn.
- **Pull non-trivial pure logic out of components** into a sibling module
  (`model-form-state.ts`) or `src/lib`, and unit-test it there — the same
  extract-the-pure-core rule as the Testing section. Dirty checks, ordering/
  diff bookkeeping and parsers don't need React to be understood or tested.
- **Never define a component inside another component** — it remounts (and
  drops state/focus) on every parent render. For markup that needs the
  parent's closure, use a plain render function (`renderCard` in
  `bom-editor.tsx`); promote it to a real component only when it can take
  props instead.

# Architecture

Decisions taken and why. The **cross-cutting rules** below apply to almost any
change and are worth keeping in context; the **deep-dive docs** hold each
subsystem's non-obvious contracts and are read on demand.

## Cross-cutting rules

- **Access control — every new page, route, or action.** The whole catalog is
  private (instances hold paid models), enforced in two layers: `src/proxy.ts`
  (Next 16's renamed middleware) does an optimistic session-*cookie* check, and
  every page/route/action *also* verifies the session server-side. Pages must
  guard with `if (!session) redirect(await signInRedirect())` (from
  `@/lib/auth`), not a bare `redirect("/sign-in")`; API/actions check too
  (list-type actions return an empty page). **Editing is collaborative** — any
  signed-in user may edit a model/collection. **Destructive/owner actions stay
  owner-gated** via `canActAsOwner(session.user, record.userId)` (which also
  passes for moderators/admins). See
  [`docs/architecture/auth-and-access.md`](docs/architecture/auth-and-access.md).
- **Model mutations must version and never orphan S3.** Run the mutation in one
  transaction with `ensureBaselineVersion` first and `recordVersion` last;
  S3-delete only the keys those helpers return, and **never** delete a
  non-variant model file's S3 object directly (old snapshots reference it). Any
  **new model listing must filter `deleted_at IS NULL`** (trash is a soft
  delete). See
  [`docs/architecture/versioning.md`](docs/architecture/versioning.md).
- **Logging & errors.** All server logging goes through the pino logger in
  `src/lib/logger.ts` — never `console.*`. In catch-and-continue blocks use
  `reportError(message, err)` (`src/lib/telemetry.ts`) rather than a bare log,
  so the error reaches the tracing backend. See
  [`docs/architecture/observability.md`](docs/architecture/observability.md).
- **Icon-only buttons get a `Tooltip`** naming the action (with a couple of
  documented exceptions). See
  [`docs/architecture/ui-conventions.md`](docs/architecture/ui-conventions.md).
- **Optional services degrade to off.** `SLICER_URL`, `OPENSCAD_URL`, and the
  OTLP endpoint are each unset-means-feature-disabled; keep new integrations
  with external services the same way.

## Deep-dive docs

Per-subsystem design notes live in
[`docs/architecture/`](docs/architecture/README.md). **Before editing one of
these subsystems, read its file** — they hold the gotchas that aren't visible
in the code, and each says what to update when you change its behaviour. They
are loaded *on demand*, not `@`-imported here (that would pull all of them into
every session and defeat the point).

| Editing… | Read first |
|---|---|
| Auth, sessions, roles, access control | [`auth-and-access.md`](docs/architecture/auth-and-access.md) |
| Model mutations, versioning, trash | [`versioning.md`](docs/architecture/versioning.md) |
| Uploads, downloads, file tokens/images | [`files.md`](docs/architecture/files.md) |
| Platform import (.3mf, MakerWorld/Printables URL, source sync, collections) | [`import.md`](docs/architecture/import.md) |
| Onshape import/sync + API client | [`onshape.md`](docs/architecture/onshape.md) |
| Slicer estimates & "open in slicer" deep links | [`slicing.md`](docs/architecture/slicing.md) |
| OpenSCAD customizer / parametric models | [`openscad.md`](docs/architecture/openscad.md) |
| Search, homepage listing, categories | [`search-and-catalog.md`](docs/architecture/search-and-catalog.md) |
| MCP server, its tools, the OAuth provider wiring | [`mcp.md`](docs/architecture/mcp.md) |
| OpenTelemetry, logging, metrics | [`observability.md`](docs/architecture/observability.md) |
| Icon-only buttons & other UI conventions | [`ui-conventions.md`](docs/architecture/ui-conventions.md) |

> Operator/user-facing docs (install, self-hosting, configuration, integration
> setup) are authored as `.mdx` in `docs/` and published as a standalone Nextra
> site built from `nextra/` — its own npm package with its own (older) Next
> version, reading `docs/` through the `nextra/content` symlink; static export,
> deployed separately (`nextra/Dockerfile`), never served by the app.
> `docs/architecture/` (the files above, for developers and agents working *on*
> the code) is excluded from the site. **A change to operator-visible behaviour
> or env vars updates the matching `docs/*.mdx` page in the same PR.** The
> `nextra/` package is excluded from the root tsconfig/ESLint; run its checks
> with `cd nextra && npm run build`.
