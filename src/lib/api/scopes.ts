// Scopes for the public REST API (/api/v1, docs/architecture/api.md) and how they map onto the api-key plugin's storage. Pure — no DB or auth imports — so the rules are unit-tested and src/lib/auth.ts can import the prefix.
//
// The plugin stores a key's grants as BetterAuth "permissions", a `{ resource: actions[] }` map (`{ models: ["read", "write"] }`). The API and its docs speak in OAuth-style scope strings ("models:write") instead, since that is what a future OAuth client or plugin manifest would request; this module is the only place the two spellings meet.

// Every key starts with this, so a leaked one is recognisable (secret scanners, logs) and can't be mistaken for another app's token.
export const API_KEY_PREFIX = "pv_";

export const API_SCOPES = [
  "models:read",
  "models:write",
  "files:read",
  "files:write",
  "collections:read",
  "collections:write",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

// Shown on Settings → API keys and in the OpenAPI document. `files:read` is spelled out as the one that hands out the bytes: metadata (BOM, estimates, tags) is enough for most integrations, while model files on an instance can be paid content.
export const API_SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  "models:read": "List and read models: metadata, tags, BOMs, print estimates",
  "models:write": "Create, edit and trash models",
  "files:read": "Download model files, images and documents",
  "files:write": "Upload files to attach to models",
  "collections:read": "List and read collections",
  "collections:write": "Add models to and remove them from collections",
};

// Presets for the key dialog — the combinations people actually want.
export const READ_ONLY_SCOPES: ApiScope[] = [
  "models:read",
  "files:read",
  "collections:read",
];
export const ALL_SCOPES: ApiScope[] = [...API_SCOPES];

export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === "string" && (API_SCOPES as readonly string[]).includes(value);
}

// Untrusted input (a form submission) → a deduped, ordered scope list, or an error. An empty list is rejected: a key that can do nothing is a mistake, not a configuration.
export function parseScopes(input: unknown): ApiScope[] | { error: string } {
  if (!Array.isArray(input)) return { error: "Scopes must be a list" };
  const unknown = input.filter((s) => !isApiScope(s));
  if (unknown.length > 0) return { error: `Unknown scope: ${String(unknown[0])}` };
  const set = new Set(input as ApiScope[]);
  if (set.size === 0) return { error: "Pick at least one scope" };
  return API_SCOPES.filter((s) => set.has(s));
}

export function scopesToPermissions(scopes: readonly ApiScope[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const scope of scopes) {
    const [resource, action] = scope.split(":");
    (out[resource] ??= []).push(action);
  }
  return out;
}

// The plugin hands permissions back parsed (or null for a key created without any, e.g. straight through /api/auth/api-key/create). Anything not in our vocabulary is dropped rather than trusted — a key can't gain a scope we don't know how to enforce.
export function permissionsToScopes(permissions: unknown): ApiScope[] {
  if (!permissions || typeof permissions !== "object") return [];
  const granted = new Set<string>();
  for (const [resource, actions] of Object.entries(permissions)) {
    if (!Array.isArray(actions)) continue;
    for (const action of actions) granted.add(`${resource}:${action}`);
  }
  return API_SCOPES.filter((s) => granted.has(s));
}

// Write implies read on the same resource: every write endpoint answers with the resource it changed, and a key that may edit a model but not look at it would be a contradiction nobody means to configure.
export function hasScope(granted: readonly ApiScope[], required: ApiScope): boolean {
  if (granted.includes(required)) return true;
  const [resource, action] = required.split(":");
  return action === "read" && granted.includes(`${resource}:write` as ApiScope);
}

// The key a request presents: `Authorization: Bearer pv_…` (what HTTP clients and n8n's "Header Auth" send) or the plugin's own `x-api-key` header.
// Only our prefix is accepted from the Authorization header, so an unrelated bearer token (an MCP JWT sent to the wrong endpoint) fails as "no key" instead of costing a hashed DB lookup.
export function apiKeyFromHeaders(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth) {
    const match = auth.match(/^Bearer\s+(\S+)$/i);
    if (match && match[1].startsWith(API_KEY_PREFIX)) return match[1];
  }
  const header = headers.get("x-api-key")?.trim();
  return header ? header : null;
}
