// Onshape REST API client (https://onshape-public.github.io/docs/). Auth is a
// per-user OAuth2 access token sent as a Bearer header (see
// src/lib/onshape/oauth.ts for the flow). Model exports are asynchronous
// translations: starting one returns a translation id that is polled until
// DONE, then the result is downloaded from the externaldata endpoint. Onshape
// only has format-specific export routes for glTF/OBJ/STEP; every other
// format (including 3MF) starts via the generic …/translations route with
// formatName in the body (see buildExportRequest). Exports are always 3MF so
// the headless slicer can slice the file (STEP is not a print format).
// Endpoint shapes verified against cad.onshape.com/api/openapi and
// https://onshape-public.github.io/docs/api-adv/translation/.

export const ONSHAPE_HOST = "cad.onshape.com";
const API_BASE = `https://${ONSHAPE_HOST}/api/v6`;

const ID_RE = /^[0-9a-f]{24}$/;

export function isOnshapeId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
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

// The canonical URL stored as a model's sourceUrl; it doubles as the
// "Edit in Onshape" link and carries everything sync needs except the
// microversion (a separate column).
export function onshapeDocumentUrl(pin: {
  documentId: string;
  wvm: string;
  wvmId: string;
  elementId?: string | null;
}): string {
  const base = `https://${ONSHAPE_HOST}/documents/${pin.documentId}/${pin.wvm}/${pin.wvmId}`;
  return pin.elementId ? `${base}/e/${pin.elementId}` : base;
}

export type OnshapeAuth = {
  accessToken: string;
};

export function onshapeAuthHeaders(auth: OnshapeAuth): Record<string, string> {
  return { Authorization: `Bearer ${auth.accessToken}` };
}

export class OnshapeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function onshapeFetch<T>(
  auth: OnshapeAuth,
  path: string,
  init?: { method?: "POST"; body?: unknown },
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      ...onshapeAuthHeaders(auth),
      Accept: "application/json",
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 401) {
    throw new OnshapeError(
      "Your Onshape connection expired — reconnect it in Settings → Onshape",
      401,
    );
  }
  if (res.status === 403 || res.status === 404) {
    throw new OnshapeError(
      "Document not found, or your Onshape account has no access to it",
      res.status,
    );
  }
  if (!res.ok) {
    throw new OnshapeError(`Onshape API responded with ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export type OnshapeSessionInfo = { name?: string; email?: string };

// Fetches the connected user's identity (for the settings page display).
// Invalid credentials don't necessarily 401 here — Onshape falls back to an
// anonymous session and answers 204 No Content — so only a 200 with a body
// counts as authenticated.
export async function getSessionInfo(auth: OnshapeAuth): Promise<OnshapeSessionInfo> {
  const res = await fetch(`${API_BASE}/users/sessioninfo`, {
    headers: { ...onshapeAuthHeaders(auth), Accept: "application/json" },
  });
  if (res.status !== 200) {
    throw new OnshapeError("Onshape did not accept the connection", 401);
  }
  return (await res.json()) as OnshapeSessionInfo;
}

export type OnshapeDocument = {
  name?: string;
  description?: string | null;
  defaultWorkspace?: { id?: string };
  thumbnail?: { sizes?: { size?: string; href?: string; mediaType?: string }[] };
};

export async function getDocument(
  auth: OnshapeAuth,
  documentId: string,
): Promise<OnshapeDocument> {
  return onshapeFetch<OnshapeDocument>(auth, `/documents/${documentId}`);
}

export type OnshapeElement = {
  id?: string;
  name?: string;
  elementType?: string;
};

export async function getElements(
  auth: OnshapeAuth,
  documentId: string,
  wvm: "w" | "v",
  wvmId: string,
): Promise<OnshapeElement[]> {
  return onshapeFetch<OnshapeElement[]>(
    auth,
    `/documents/d/${documentId}/${wvm}/${wvmId}/elements`,
  );
}

export async function getCurrentMicroversion(
  auth: OnshapeAuth,
  documentId: string,
  wvm: "w" | "v",
  wvmId: string,
): Promise<string | null> {
  const info = await onshapeFetch<{ microversion?: string }>(
    auth,
    `/documents/d/${documentId}/${wvm}/${wvmId}/currentmicroversion`,
  );
  return info.microversion ?? null;
}

type TranslationInfo = {
  id?: string;
  requestState?: "ACTIVE" | "DONE" | "FAILED";
  failureReason?: string;
  resultExternalDataIds?: string[];
};

// How long to wait for one export. Exports of typical hobby models take
// seconds; the importing route caps the whole request at 300s anyway.
const TRANSLATION_TIMEOUT_MS = 240_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Builds the request that starts an async 3MF export. There is no dedicated
// …/export/3mf route (the docs list format-specific routes for glTF/OBJ/STEP
// only — POST …/export/3MF 404s, which the UI surfaces as "document not
// found"), so the export goes through the generic …/translations route with
// the format named in the body.
export function buildExportRequest(
  elementType: string,
  pin: { documentId: string; wvm: "w" | "v"; wvmId: string },
  elementId: string,
): { path: string; body: Record<string, unknown> } {
  const resource = elementType === "ASSEMBLY" ? "assemblies" : "partstudios";
  return {
    path: `/${resource}/d/${pin.documentId}/${pin.wvm}/${pin.wvmId}/e/${elementId}/translations`,
    body: {
      formatName: "3MF",
      storeInDocument: false,
      notifyUser: false,
      translate: true,
    },
  };
}

// Exports one element as 3MF and returns an authenticated download URL for
// the resulting file (the caller streams it to S3 with the same auth
// headers). 3MF rather than a CAD format so the headless slicer can slice it.
export async function exportModel(
  auth: OnshapeAuth,
  pin: { documentId: string; wvm: "w" | "v"; wvmId: string },
  element: { id: string; elementType: string; name: string },
): Promise<string> {
  const request = buildExportRequest(element.elementType, pin, element.id);
  const started = await onshapeFetch<TranslationInfo>(auth, request.path, {
    method: "POST",
    body: request.body,
  });
  if (!started.id) {
    throw new OnshapeError(`Onshape did not start the export of "${element.name}"`);
  }

  const deadline = Date.now() + TRANSLATION_TIMEOUT_MS;
  let delay = 1000;
  let translation = started;
  while (translation.requestState === "ACTIVE" || !translation.requestState) {
    if (Date.now() > deadline) {
      throw new OnshapeError(`Onshape export of "${element.name}" timed out`);
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 5000);
    translation = await onshapeFetch<TranslationInfo>(auth, `/translations/${started.id}`);
  }
  if (translation.requestState === "FAILED") {
    throw new OnshapeError(
      `Onshape export of "${element.name}" failed` +
        (translation.failureReason ? `: ${translation.failureReason}` : ""),
    );
  }
  const fid = translation.resultExternalDataIds?.[0];
  if (!fid) {
    throw new OnshapeError(`Onshape export of "${element.name}" returned no file`);
  }
  return `${API_BASE}/documents/d/${pin.documentId}/externaldata/${fid}`;
}

export type OnshapeExport = {
  elementId: string;
  filename: string;
  url: string;
};

const MAX_EXPORT_ELEMENTS = 8;

function modelFilename(name: string): string {
  const base = name.trim().replace(/[^a-zA-Z0-9._ -]/g, "_") || "model";
  return `${base}.3mf`;
}

// Exports the elements a document pin refers to as 3MF: the pinned element when
// the URL contains /e/{eid}, otherwise every Part Studio and Assembly tab
// (capped). Used by both the URL importer and the sync endpoint so they stay in
// lockstep.
export async function exportPinnedModels(
  auth: OnshapeAuth,
  pin: { documentId: string; wvm: "w" | "v"; wvmId: string; elementId: string | null },
): Promise<{ exports: OnshapeExport[]; warnings: string[] }> {
  const warnings: string[] = [];
  const elements = (await getElements(auth, pin.documentId, pin.wvm, pin.wvmId)).filter(
    (e): e is { id: string; name: string; elementType: string } =>
      isOnshapeId(e.id) &&
      (e.elementType === "PARTSTUDIO" || e.elementType === "ASSEMBLY"),
  );

  let selected = elements;
  if (pin.elementId) {
    selected = elements.filter((e) => e.id === pin.elementId);
    if (selected.length === 0) {
      throw new OnshapeError(
        "The linked Onshape tab no longer exists or is not a Part Studio/Assembly",
      );
    }
  } else if (selected.length > MAX_EXPORT_ELEMENTS) {
    warnings.push(
      `Only the first ${MAX_EXPORT_ELEMENTS} Part Studio/Assembly tabs were exported.`,
    );
    selected = selected.slice(0, MAX_EXPORT_ELEMENTS);
  }
  if (selected.length === 0) {
    throw new OnshapeError("The Onshape document has no Part Studio or Assembly tabs");
  }

  const exports: OnshapeExport[] = [];
  const usedNames = new Set<string>();
  for (const element of selected) {
    const url = await exportModel(auth, pin, {
      id: element.id,
      elementType: element.elementType,
      name: element.name || element.id,
    });
    let filename = modelFilename(element.name || element.id);
    if (usedNames.has(filename.toLowerCase())) {
      filename = modelFilename(`${element.name || "model"}-${element.id.slice(0, 6)}`);
    }
    usedNames.add(filename.toLowerCase());
    exports.push({ elementId: element.id, filename, url });
  }
  return { exports, warnings };
}
