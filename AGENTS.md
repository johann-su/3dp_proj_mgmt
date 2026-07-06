<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Testing

Unit tests run on Node's built-in test runner (`node:test` + `node:assert/strict`)
via `tsx` — there is no Vitest/Jest. Run the whole suite with `npm test`.

Conventions:

- Co-locate tests next to the code as `*.test.ts` (e.g. `src/lib/format.ts` →
  `src/lib/format.test.ts`). The `npm test` glob picks up any `src/**/*.test.ts`.
- Import from source with the `@/` alias; `tsx` resolves it from `tsconfig.json`.
- Prefer testing **pure logic** (URL parsers, formatters, BOM/CSV helpers,
  validation). Do not import modules with load-time side effects into a test —
  e.g. `@/lib/s3` builds an S3 client from env, `@/db` opens a pool. Test the
  pure helper directly, or extract it, rather than pulling those in.
- No DB or network in unit tests. If a function needs them, pass the data in or
  stub `fetch`; keep the estimate/import HTTP flows for manual/integration checks.

Example:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "@/lib/format";

test("formatDuration splits hours and minutes", () => {
  assert.equal(formatDuration(5460), "1 h 31 min");
});
```

# Documentation Sources

- [Onshape API](https://onshape-public.github.io/docs/api-intro/)