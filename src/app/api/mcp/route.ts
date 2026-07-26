import { NextResponse } from "next/server";
import { withMcpAuth } from "better-auth/plugins";
import { auth, mcpEnabled } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { handleMcpPayload, parseErrorResponse } from "@/lib/mcp/protocol";
import { catalogTools, CATALOG_INSTRUCTIONS } from "@/lib/mcp/tools";
import { reportError } from "@/lib/telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The MCP endpoint (issue #96): read-only catalog tools for LLM clients.
//
// Authentication is an OAuth bearer token, not a session cookie — withMcpAuth
// resolves it against the tokens BetterAuth's `mcp` plugin issued and answers
// 401 with the `WWW-Authenticate: resource_metadata=…` header a client needs to
// discover where to get one. A token grants exactly what its user can see in
// the browser: the whole catalog, read-only (see auth-and-access.md).
//
// Transport shape and why it is hand-rolled: see src/lib/mcp/protocol.ts.

const serverInfo = {
  name: "print-vault",
  title: "Print Vault",
  // Set when the app is started through npm; the Docker image runs server.js
  // directly, where it isn't — hence the package.json version as a fallback.
  version: process.env.npm_package_version ?? "0.1.0",
};

const handler = withMcpAuth(auth, async (req, session) => {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(parseErrorResponse(), { status: 400 });
  }

  const response = await handleMcpPayload(payload, {
    tools: catalogTools,
    serverInfo,
    instructions: CATALOG_INSTRUCTIONS,
    onError: reportError,
  });

  logger.debug(
    { userId: session.userId, clientId: session.clientId },
    "[mcp] request handled",
  );

  // A body of notifications only has nothing to answer.
  return response === null
    ? new Response(null, { status: 202 })
    : NextResponse.json(response);
});

export async function POST(req: Request) {
  if (!mcpEnabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return handler(req);
}

// This server never initiates messages, so it offers no event stream to open
// (the spec's answer for that is 405, not 404 — the endpoint exists).
export async function GET() {
  return NextResponse.json(
    { error: "Method not allowed" },
    { status: 405, headers: { Allow: "POST" } },
  );
}

// Stateless: there is no session for a client to end.
export const DELETE = GET;
