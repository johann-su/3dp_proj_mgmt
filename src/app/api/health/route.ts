import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Liveness probe for the Docker HEALTHCHECK (see Dockerfile) and Dokploy's
// deploy cutover — confirms the Next.js server is up and responding, nothing
// more. Intentionally unauthenticated and DB-free, mirroring the slicer/
// openscad services' own /healthz: a dependency check here would make the
// container flap unhealthy on a transient DB blip instead of just the page
// loads that actually need it.
export async function GET() {
  return NextResponse.json({ status: "ok" });
}
