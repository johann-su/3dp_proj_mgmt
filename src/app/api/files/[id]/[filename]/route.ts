import type { NextRequest } from "next/server";
import { GET as getFile } from "../route";

export const runtime = "nodejs";

// Same file as `/api/files/[id]`, but with the filename as a trailing path
// segment (`/api/files/<id>/<name>.3mf`). The name is ignored server-side — the
// UUID `id` is authoritative — but it lets slicer deep links (OrcaSlicer, Bambu
// Studio) derive a real `.3mf` filename from the URL's last segment instead of
// the bare UUID. See `file-download-menu.tsx`.
export function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; filename: string }> },
) {
  return getFile(req, { params });
}
