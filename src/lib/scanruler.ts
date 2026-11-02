// ScanRuler (https://github.com/CNCKitchen/scanruler, AGPL-3.0) is a browser
// app for measuring 3D scans, cleaning up meshes and reverse engineering them
// into STEP solids. This project is MIT, so the integration stays at arm's
// length: we never import or bundle its code — we only hand the user's browser
// a link that opens one of our files there (`?open=<url>`), and the results
// come back as ordinary uploads. See docs/architecture/scanruler.md.
//
// Pure helpers, no I/O, so they can be shared by the server (env parsing,
// CORS) and the download menu (link building), and unit-tested.

import { fileExtension } from "@/lib/file-kind";

// ScanRuler's workspace ids, as its `?workspace=` parameter takes them (its
// TopBar + plugin ids). Only the ones that work on a single opened file are
// offered: Deviation needs a second (reference) file the link can't carry.
export const SCANRULER_WORKSPACES = [
  { id: "measure", label: "Measure" },
  { id: "mesh", label: "Mesh Tools" },
  { id: "reverse", label: "Reverse engineer" },
] as const;

export type ScanRulerWorkspace = (typeof SCANRULER_WORKSPACES)[number]["id"];

// Formats both sides understand: ScanRuler opens 3MF and STEP as a scan (it
// also reads STL/PLY/OBJ, which this catalog doesn't store), and `.scanruler`
// projects it saved itself. `.scad` is source code, nothing to measure.
const OPENABLE = [".3mf", ".step", ".stp", ".scanruler"];

export function scanRulerOpens(filename: string): boolean {
  return OPENABLE.includes(fileExtension(filename));
}

// SCANRULER_URL is the ScanRuler deployment to link to — https://scanruler.com/
// or a self-hosted build. Unset (or not an http(s) URL) disables the feature,
// like the other optional services. Normalized to end in "/" so the query
// string attaches to the app's index page.
export function scanRulerBase(
  raw: string | undefined = process.env.SCANRULER_URL,
): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

// The link that makes ScanRuler fetch `fileUrl` in the browser and land in a
// workspace. ScanRuler names the opened file after the URL's last path
// segment — hence the tokened path route, whose last segment is the filename.
export function scanRulerOpenUrl(
  base: string,
  fileUrl: string,
  workspace: ScanRulerWorkspace,
): string {
  const url = new URL(base);
  url.searchParams.set("open", fileUrl);
  url.searchParams.set("workspace", workspace);
  return url.href;
}

// ScanRuler fetches the file from its own origin (`fetch(url, { mode:
// 'cors' })`), so the tokened file routes must let exactly that origin read the
// response. A plain GET with no custom headers needs no preflight. Anything
// else — no Origin, another site, feature off — gets no CORS headers, so the
// browser keeps refusing it. No Allow-Credentials: the token in the path is
// the credential, cookies never ride along.
export function scanRulerCorsHeaders(
  requestOrigin: string | null,
  base: string | null,
): Record<string, string> | null {
  if (!requestOrigin || !base) return null;
  if (requestOrigin !== new URL(base).origin) return null;
  return { "Access-Control-Allow-Origin": requestOrigin, Vary: "Origin" };
}
