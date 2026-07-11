import { NextRequest, NextResponse } from "next/server";
import { renderScad } from "@/lib/openscad";
import { prepareScadRender } from "../render-request";

export const runtime = "nodejs";
// Rendering waits on the OpenSCAD service (2 min timeout plus queueing).
export const maxDuration = 300;

// Ephemeral render for the customize page's 3D preview: same validation as
// generate, but the result streams straight back as binary STL (three.js
// parses it directly) and nothing is stored — previews shouldn't count
// against the variant cap or leave S3 objects behind.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const request = await prepareScadRender(id, await req.json().catch(() => null));
  if ("error" in request) {
    return NextResponse.json({ error: request.error }, { status: request.status });
  }

  const rendered = await renderScad(request.scadSource, request.values, "stl");
  if (!rendered.ok) {
    const status = rendered.status === 422 ? 422 : 502;
    return NextResponse.json({ error: rendered.error }, { status });
  }

  return new NextResponse(Buffer.from(rendered.data), {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
    },
  });
}
