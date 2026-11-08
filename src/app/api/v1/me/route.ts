import { apiJson } from "@/lib/api/http";
import { apiRoute } from "@/lib/api/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Who this key acts as and what it may do — the first call an integration makes to check its configuration. Works for any valid key, whatever its scopes.
export const GET = apiRoute(null, async ({ principal }) =>
  apiJson({
    user: principal.user,
    key: {
      id: principal.key.id,
      name: principal.key.name,
      scopes: principal.scopes,
      expiresAt: principal.key.expiresAt?.toISOString() ?? null,
    },
  }),
);
