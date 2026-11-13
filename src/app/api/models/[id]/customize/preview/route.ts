import { NextRequest, NextResponse } from "next/server";
import { compressBody, pickContentEncoding } from "@/lib/http-encoding";
import { renderScad } from "@/lib/openscad";
import { prepareScadRender } from "../render-request";

export const runtime = "nodejs";
// Rendering waits on the OpenSCAD service (2 min timeout plus queueing).
export const maxDuration = 300;

// Ephemeral render for the customize page's 3D preview: same validation as generate, but the result streams straight back as binary STL (three.js parses it directly) and nothing is stored — previews shouldn't count against the variant cap or leave S3 objects behind.
//
// The customizer aborts a preview when a newer parameter change supersedes it; req.signal carries that through to the OpenSCAD service, which drops the queued job or kills the running one. The STL is compressed here because Next's own compression skips application/octet-stream.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const request = await prepareScadRender(id, await req.json().catch(() => null));
  if ("error" in request) {
    return NextResponse.json({ error: request.error }, { status: request.status });
  }

  const rendered = await renderScad(request.scadSource, request.values, "stl", req.signal);
  if (!rendered.ok) {
    // 499: the browser already went away, so nobody reads this.
    const status = rendered.status === 422 || rendered.status === 499 ? rendered.status : 502;
    return NextResponse.json({ error: rendered.error }, { status });
  }

  const encoding = pickContentEncoding(req.headers.get("accept-encoding"));
  const body = encoding
    ? await compressBody(rendered.data, encoding)
    : Buffer.from(rendered.data);
  return new NextResponse(body, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      vary: "accept-encoding",
      ...(encoding ? { "content-encoding": encoding } : {}),
    },
  });
}
