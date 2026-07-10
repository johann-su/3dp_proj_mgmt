import type { NextRequest } from "next/server";
import { GET as getFile } from "../../route";

export const runtime = "nodejs";

// Same file as `/api/files/[id]`, addressed as
// `/api/files/<id>/<token>/<name>.3mf` for slicer deep links (OrcaSlicer,
// Bambu Studio), which download the URL without cookies:
//  - the signed `token` path segment authenticates the request, and
//  - the trailing `filename` is ignored server-side (the UUID `id` is
//    authoritative) but lets Orca derive a real `.3mf` name from the URL's
//    last path segment. Orca does NOT strip query strings when doing so
//    (`filename_from_url` in Downloader.cpp), which is why the token is a
//    path segment and not `?token=`. See `file-download-menu.tsx`.
export function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; token: string; filename: string }> },
) {
  return getFile(req, { params });
}
