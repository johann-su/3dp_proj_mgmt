// The upstream sources a model can be imported from and synced against —
// MakerWorld, Printables, Onshape — described in one place. Everything that
// used to carry its own list of platforms (the cover badge, the smart-
// collection "source" rule, duplicate detection's design identity, the
// sourceUrl allowlist on save) reads it from here, so adding a source is one
// descriptor plus an importer (src/lib/sources/importers.ts) instead of a
// hunt through a dozen files. This is the in-process seam a future plugin
// system would register sources through (docs/architecture/import.md).
//
// Pure and client-safe on purpose: the model page and the rule builder are
// client components that render source labels, so nothing here may import
// server-only modules. The URL parsers live here for that reason and are
// re-exported from the importer modules that historically owned them.

export type SourcePlatform = "makerworld" | "printables" | "onshape";

export type SourceDescriptor = {
  id: SourcePlatform;
  label: string;
  // Shown in the "unsupported URL" message so a user knows what to paste.
  exampleUrl: string;
  // Which URLs belong to the source at all (any page on its site). Decides the
  // cover badge and the smart-collection "source" rule; must agree with
  // hostSqlRegex, which is the same test expressed for Postgres' `~`.
  matchesHost(hostname: string): boolean;
  hostSqlRegex: string;
  // Whether a URL may be stored as a model's sourceUrl — stricter than the
  // host check: https only, and for Onshape the CAD host only.
  acceptsSourceUrl(url: URL): boolean;
  // The stable id of the upstream design a URL names, or null when the URL
  // isn't a design page. Duplicate detection compares these, never the URL
  // string (print-profile hashes, branch pins and tabs all vary per import).
  designId(url: URL): string | null;
  // A substring every sourceUrl naming that design contains — a cheap SQL
  // prefilter that over-matches on purpose (see duplicate-key.ts).
  designUrlFragment(designId: string): string;
  // Format check for the opaque upstream revision token stored on the model
  // (models.source_revision), for sources that have one. Values that fail it
  // are dropped on save, since they ride in through the client draft.
  isRevisionToken?(value: string): boolean;
};

// --- URL parsers -----------------------------------------------------------

export function parseMakerworldUrl(url: URL): string | null {
  if (!/(^|\.)makerworld\.com$/.test(url.hostname)) return null;
  const match = url.pathname.match(/\/models\/(\d+)/);
  return match ? match[1] : null;
}

export function parseMakerworldCollectionUrl(url: URL): string | null {
  if (!/(^|\.)makerworld\.com$/.test(url.hostname)) return null;
  const match = url.pathname.match(/\/collections\/(\d+)/);
  return match ? match[1] : null;
}

export function parsePrintablesUrl(url: URL): string | null {
  if (!/(^|\.)printables\.com$/.test(url.hostname)) return null;
  const match = url.pathname.match(/\/model\/(\d+)/);
  return match ? match[1] : null;
}

export const ONSHAPE_HOST = "cad.onshape.com";

const ONSHAPE_ID_RE = /^[0-9a-f]{24}$/;

export function isOnshapeId(value: unknown): value is string {
  return typeof value === "string" && ONSHAPE_ID_RE.test(value);
}

// A parsed document URL: cad.onshape.com/documents/{did}[/w|v|m/{wvmid}][/e/{eid}].
// w = workspace (branch, syncable), v = version (immutable snapshot),
// m = microversion (rejected at import — not exportable via the wv endpoints).
export type OnshapePin = {
  documentId: string;
  wvm: "w" | "v" | "m" | null;
  wvmId: string | null;
  elementId: string | null;
};

export function parseOnshapeUrl(url: URL): OnshapePin | null {
  if (url.hostname !== ONSHAPE_HOST) return null;
  const match = url.pathname.match(
    /^\/documents\/([0-9a-f]{24})(?:\/(w|v|m)\/([0-9a-f]{24}))?(?:\/e\/([0-9a-f]{24}))?/,
  );
  if (!match) return null;
  return {
    documentId: match[1],
    wvm: (match[2] as "w" | "v" | "m" | undefined) ?? null,
    wvmId: match[3] ?? null,
    elementId: match[4] ?? null,
  };
}

// --- Descriptors -------------------------------------------------------------

const subdomainOf = (domain: string) => {
  const re = new RegExp(`(^|\\.)${domain.replace(/\./g, "\\.")}$`);
  return (hostname: string) => re.test(hostname);
};

const hostSql = (domain: string) =>
  `^https?://([^/]*\\.)?${domain.replace(/\./g, "\\.")}(/|$)`;

export const SOURCES: readonly SourceDescriptor[] = [
  {
    id: "makerworld",
    label: "MakerWorld",
    exampleUrl: "makerworld.com/…/models/…",
    matchesHost: subdomainOf("makerworld.com"),
    hostSqlRegex: hostSql("makerworld.com"),
    acceptsSourceUrl: (url) =>
      url.protocol === "https:" && subdomainOf("makerworld.com")(url.hostname),
    designId: parseMakerworldUrl,
    designUrlFragment: (id) => `/models/${id}`,
  },
  {
    id: "printables",
    label: "Printables",
    exampleUrl: "printables.com/model/…",
    matchesHost: subdomainOf("printables.com"),
    hostSqlRegex: hostSql("printables.com"),
    acceptsSourceUrl: (url) =>
      url.protocol === "https:" && subdomainOf("printables.com")(url.hostname),
    designId: parsePrintablesUrl,
    designUrlFragment: (id) => `/model/${id}`,
  },
  {
    id: "onshape",
    label: "Onshape",
    exampleUrl: "cad.onshape.com/documents/…",
    matchesHost: subdomainOf("onshape.com"),
    hostSqlRegex: hostSql("onshape.com"),
    acceptsSourceUrl: (url) => url.protocol === "https:" && url.hostname === ONSHAPE_HOST,
    // The document id alone is the identity: a version-pinned (/v/) import, a
    // different branch and another tab of the same document are all the same
    // upstream design, so wvm/wvmId/elementId are deliberately ignored.
    designId: (url) => parseOnshapeUrl(url)?.documentId ?? null,
    designUrlFragment: (id) => `/documents/${id}`,
    // The workspace microversion at the last import/sync.
    isRevisionToken: (value) => isOnshapeId(value),
  },
];

export const SOURCE_PLATFORMS: readonly SourcePlatform[] = SOURCES.map((s) => s.id);

export function isSourcePlatform(value: unknown): value is SourcePlatform {
  return typeof value === "string" && (SOURCE_PLATFORMS as readonly string[]).includes(value);
}

export function sourceById(id: SourcePlatform): SourceDescriptor {
  const source = SOURCES.find((s) => s.id === id);
  if (!source) throw new Error(`Unknown source ${id}`);
  return source;
}

export const sourceLabels = Object.fromEntries(
  SOURCES.map((s) => [s.id, s.label]),
) as Record<SourcePlatform, string>;

function toUrl(raw: string | URL | null | undefined): URL | null {
  if (!raw) return null;
  if (raw instanceof URL) return raw;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

// The source a URL's host belongs to — detection is purely by hostname.
export function sourceForUrl(raw: string | URL | null | undefined): SourceDescriptor | null {
  const url = toUrl(raw);
  if (!url) return null;
  return SOURCES.find((s) => s.matchesHost(url.hostname)) ?? null;
}

// Validates a sourceUrl about to be stored on a model and returns its
// canonical form: null when none was given, undefined when it is not a link
// to a known source (the caller rejects the save). Tracking params
// (?from=recommend etc.) are dropped; the hash stays, since on MakerWorld it
// identifies the print profile.
export function canonicalSourceUrl(raw: string | null | undefined): string | null | undefined {
  if (!raw) return null;
  const url = toUrl(raw);
  if (!url) return undefined;
  if (!SOURCES.some((s) => s.acceptsSourceUrl(url))) return undefined;
  url.search = "";
  return url.toString();
}

function orList(parts: string[]): string {
  return parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`
    : parts.join("");
}

// "MakerWorld, Printables or Onshape".
export function supportedSourceNames(): string {
  return orList(SOURCES.map((s) => s.label));
}

// "MakerWorld (makerworld.com/…/models/…), Printables (…) or Onshape (…)".
export function supportedSourcesSentence(): string {
  return orList(SOURCES.map((s) => `${s.label} (${s.exampleUrl})`));
}
