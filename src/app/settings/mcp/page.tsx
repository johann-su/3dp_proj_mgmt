import { notFound, redirect } from "next/navigation";
import { getSession, mcpEnabled, MCP_ENDPOINT_PATH, signInRedirect } from "@/lib/auth";
import { appUrl } from "@/lib/app-url";
import { listMcpClients } from "@/lib/mcp/clients";
import { McpConnections } from "./mcp-connections";

export const dynamic = "force-dynamic";

export default async function McpSettingsPage() {
  const session = await getSession();
  if (!session) redirect(await signInRedirect());
  // Not configured on this instance — the nav entry hides too, but a
  // bookmarked URL must not render a page for a feature that isn't there.
  if (!mcpEnabled) notFound();

  const clients = await listMcpClients(session.user.id);

  return (
    <div className="max-w-2xl">
      <h1 className="text-lg font-semibold mb-1">AI assistant access (MCP)</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Connect an AI assistant — Claude, ChatGPT or anything else that speaks
        the Model Context Protocol — so it can answer questions about your
        models: what to print them in, whether they need supports, what the
        parts cost, how long a build takes. Access is read-only, and connecting
        starts in the assistant, not here.
      </p>
      <McpConnections
        endpoint={appUrl(MCP_ENDPOINT_PATH).toString()}
        clients={clients.map((client) => ({
          ...client,
          connectedAt: client.connectedAt.toISOString(),
          lastIssuedAt: client.lastIssuedAt.toISOString(),
        }))}
      />
    </div>
  );
}
