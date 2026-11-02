import type { NextRequest } from "next/server";
import { scanRulerBase, scanRulerCorsHeaders } from "@/lib/scanruler";
import { GET as getSharedFile } from "../../route";

export const runtime = "nodejs";

// Same file as `/api/files/shared/[fileId]?share=<token>`, addressed as
// `/api/files/shared/<id>/<token>/<name>.3mf` for slicer and ScanRuler deep
// links from public share pages — the share-link twin of
// /api/files/[id]/[token]/[filename] (see that route and file-download-menu.tsx
// for why the credential must be a path segment and the filename comes last,
// and for the ScanRuler CORS grant). The filename is cosmetic; the share link
// is re-checked exactly as for the query form.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ fileId: string; token: string; filename: string }> },
) {
  const res = await getSharedFile(req, { params });
  const cors = scanRulerCorsHeaders(req.headers.get("origin"), scanRulerBase());
  for (const [key, value] of Object.entries(cors ?? {})) res.headers.set(key, value);
  return res;
}
