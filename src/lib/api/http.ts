// Response conventions of /api/v1, in one place: JSON bodies, the error
// envelope `{ error, code }` (schemas.ts › ApiError), and how the mutation
// core's outcomes map onto status codes. Pure — plain `Response`, no Next.js —
// so the mapping is unit-tested.

import type { ZodError } from "zod";
import type { MutationError } from "@/lib/model-mutations";

export type ApiErrorCode =
  | "unauthorized"
  | "insufficient_scope"
  | "invalid_request"
  | "not_found"
  | "forbidden"
  | "duplicate"
  | "rate_limited"
  | "payload_too_large"
  | "internal";

// Every API answer is per-key, private data: never cache it anywhere.
const BASE_HEADERS = { "Cache-Control": "no-store" };

export function apiJson(
  data: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return Response.json(data, {
    status: init.status ?? 200,
    headers: { ...BASE_HEADERS, ...init.headers },
  });
}

export function apiError(
  status: number,
  code: ApiErrorCode,
  error: string,
  extra: { headers?: Record<string, string>; body?: Record<string, unknown> } = {},
): Response {
  return apiJson({ error, code, ...extra.body }, { status, headers: extra.headers });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

// `files.0.upload` style paths, so a client can point at the offending field.
export function zodIssues(error: ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

export function invalidRequest(error: ZodError | string): Response {
  return typeof error === "string"
    ? apiError(400, "invalid_request", error)
    : apiError(400, "invalid_request", "The request body is invalid", {
        body: { issues: zodIssues(error) },
      });
}

const STATUS_FOR: Record<MutationError["code"], [number, ApiErrorCode]> = {
  invalid: [400, "invalid_request"],
  not_found: [404, "not_found"],
  forbidden: [403, "forbidden"],
};

export function mutationError(err: MutationError): Response {
  const [status, code] = STATUS_FOR[err.code];
  return apiError(status, code, err.error);
}

// The flag-only duplicate prompt (issue #118) as an HTTP conflict: nothing was
// saved, and repeating the request with confirmDuplicate saves anyway.
export function duplicateConflict(
  duplicates: { id: string; title: string }[],
  url: (path: string) => string,
): Response {
  return apiError(
    409,
    "duplicate",
    "A model file matches one already in the catalog — repeat with confirmDuplicate: true to save anyway",
    {
      body: {
        duplicates: duplicates.map((d) => ({
          id: d.id,
          title: d.title,
          url: url(`/models/${d.id}`),
        })),
      },
    },
  );
}
