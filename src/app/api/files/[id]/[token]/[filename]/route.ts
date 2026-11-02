import type { NextRequest } from "next/server";
import { scanRulerBase, scanRulerCorsHeaders } from "@/lib/scanruler";
import { GET as getFile } from "../../route";

export const runtime = "nodejs";

// Same file as `/api/files/[id]`, addressed as
// `/api/files/<id>/<token>/<name>.3mf` for cookie-less consumers that name the
// file after the URL — slicer deep links (OrcaSlicer, Bambu Studio) and
// ScanRuler's `?open=` (src/lib/scanruler.ts):
//  - the signed `token` path segment authenticates the request, and
//  - the trailing `filename` is ignored server-side (the UUID `id` is
//    authoritative) but lets Orca derive a real `.3mf` name from the URL's
//    last path segment. Orca does NOT strip query strings when doing so
//    (`filename_from_url` in Downloader.cpp), which is why the token is a
//    path segment and not `?token=`. See `file-download-menu.tsx`.
// ScanRuler fetches from its own web origin, so that one origin (and only
// it) gets a CORS grant here; the cookie-authenticated routes never do.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; token: string; filename: string }> },
) {
  const res = await getFile(req, { params });
  const cors = scanRulerCorsHeaders(req.headers.get("origin"), scanRulerBase());
  for (const [key, value] of Object.entries(cors ?? {})) res.headers.set(key, value);
  return res;
}
