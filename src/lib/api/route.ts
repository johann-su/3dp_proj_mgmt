// The wrapper every /api/v1 route goes through: the ENABLE_API gate, API-key
// authentication, the scope check, and error handling. A route handler only
// ever sees an authenticated principal that holds the scope it declared.
//
// Keys are verified through the api-key plugin (hashed lookup, expiry,
// per-key rate limit) and then *re-attached to their user*: the key carries
// the user id, the user row carries the role that owner-gated mutations
// check. A deleted user's keys are gone by FK cascade, and the row lookup
// would refuse them anyway.

import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { db } from "@/db";
import { user } from "@/db/schema";
import { apiEnabled, auth } from "@/lib/auth";
import { reportError } from "@/lib/telemetry";
import { apiError, invalidRequest } from "./http";
import {
  apiKeyFromHeaders,
  hasScope,
  permissionsToScopes,
  type ApiScope,
} from "./scopes";

export type ApiPrincipal = {
  user: { id: string; name: string; role: string };
  scopes: ApiScope[];
  key: { id: string; name: string | null; expiresAt: Date | null };
};

const CHALLENGE = { "WWW-Authenticate": 'Bearer realm="print-vault"' };

async function authenticate(request: Request): Promise<ApiPrincipal | Response> {
  const presented = apiKeyFromHeaders(request.headers);
  if (!presented) {
    return apiError(
      401,
      "unauthorized",
      "Send an API key as `Authorization: Bearer pv_…` (create one under Settings → API keys)",
      { headers: CHALLENGE },
    );
  }

  const result = await auth.api.verifyApiKey({ body: { key: presented } });
  if (!result.valid || !result.key) {
    if (result.error?.code === "RATE_LIMITED") {
      const ms = Number((result.error as { details?: { tryAgainIn?: number } }).details?.tryAgainIn);
      return apiError(429, "rate_limited", "Too many requests for this API key", {
        headers: Number.isFinite(ms) ? { "Retry-After": String(Math.ceil(ms / 1000)) } : {},
      });
    }
    return apiError(401, "unauthorized", "The API key is invalid, expired or revoked", {
      headers: CHALLENGE,
    });
  }

  const owner = await db.query.user.findFirst({
    where: eq(user.id, result.key.referenceId),
    columns: { id: true, name: true, role: true },
  });
  if (!owner) {
    return apiError(401, "unauthorized", "The API key is invalid, expired or revoked", {
      headers: CHALLENGE,
    });
  }

  return {
    user: owner,
    scopes: permissionsToScopes(result.key.permissions),
    key: {
      id: result.key.id,
      name: result.key.name ?? null,
      expiresAt: result.key.expiresAt ? new Date(result.key.expiresAt) : null,
    },
  };
}

type Handler<P> = (ctx: {
  request: NextRequest;
  principal: ApiPrincipal;
  params: P;
}) => Promise<Response>;

// `scope: null` only requires a valid key (GET /me answers "what can this key
// do", so it must work for every key).
export function apiRoute<P = Record<string, never>>(
  scope: ApiScope | null,
  handler: Handler<P>,
) {
  return async (request: NextRequest, context: { params: Promise<P> }): Promise<Response> => {
    if (!apiEnabled) return apiError(404, "not_found", "Not found");

    const principal = await authenticate(request);
    if (principal instanceof Response) return principal;
    if (scope && !hasScope(principal.scopes, scope)) {
      return apiError(403, "insufficient_scope", `This API key lacks the ${scope} scope`, {
        headers: {
          "WWW-Authenticate": `Bearer realm="print-vault", error="insufficient_scope", scope="${scope}"`,
        },
      });
    }

    try {
      return await handler({ request, principal, params: await context.params });
    } catch (err) {
      if (err instanceof ZodError) return invalidRequest(err);
      reportError("API request failed", err);
      return apiError(500, "internal", "Something went wrong");
    }
  };
}

// The JSON body, or a ZodError-shaped 400 for anything that isn't JSON.
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ZodError([
      { code: "custom", path: [], message: "The body must be JSON", input: undefined },
    ]);
  }
}
