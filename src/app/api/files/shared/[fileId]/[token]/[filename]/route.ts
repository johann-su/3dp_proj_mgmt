import type { NextRequest } from "next/server";
import { GET as getSharedFile } from "../../route";

export const runtime = "nodejs";

// Same file as `/api/files/shared/[fileId]?share=<token>`, addressed as
// `/api/files/shared/<id>/<token>/<name>.3mf` for slicer deep links from
// public share pages — the share-link twin of /api/files/[id]/[token]/[filename]
// (see that route and file-download-menu.tsx for why the credential must be a
// path segment and the filename comes last). The filename is cosmetic; the
// share link is re-checked exactly as for the query form.
export function GET(
  req: NextRequest,
  { params }: { params: Promise<{ fileId: string; token: string; filename: string }> },
) {
  return getSharedFile(req, { params });
}
