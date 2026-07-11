// Client for the headless OpenSCAD service (./openscad), which wraps the
// OpenSCAD CLI behind POST /render. Unlike the slicer there is no pending/
// retry machinery: rendering happens synchronously inside the customize
// request (src/app/api/models/[id]/customize) and the user sees the result or
// the error right away. Without OPENSCAD_URL the customizer UI is hidden and
// .scad files are plain downloads.

// Keep in sync with MAX_BODY_BYTES in openscad/server.mjs.
export const MAX_SCAD_SOURCE_BYTES = 2 * 1024 * 1024;
// Covers the service's 2 min render timeout plus queueing behind another job.
const REQUEST_TIMEOUT_MS = 5 * 60_000;

export function openscadConfigured(): boolean {
  return Boolean(process.env.OPENSCAD_URL);
}

export type RenderResult =
  | { ok: true; data: Uint8Array }
  | { ok: false; status: number; error: string };

// "3mf" for files that get stored; "stl" (binary) for the customize page's
// browser preview, which three.js parses directly.
export type RenderFormat = "3mf" | "stl";

export async function renderScad(
  source: string,
  parameters: Record<string, string>,
  format: RenderFormat = "3mf",
): Promise<RenderResult> {
  const url = process.env.OPENSCAD_URL;
  if (!url) {
    return { ok: false, status: 503, error: "OpenSCAD service is not configured" };
  }

  let res: Response;
  try {
    res = await fetch(new URL("/render", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, parameters, format }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.error("openscad service unreachable:", err);
    return { ok: false, status: 502, error: "OpenSCAD service is unreachable" };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return {
      ok: false,
      status: res.status,
      error: body?.error ?? `OpenSCAD service responded with ${res.status}`,
    };
  }
  return { ok: true, data: new Uint8Array(await res.arrayBuffer()) };
}
