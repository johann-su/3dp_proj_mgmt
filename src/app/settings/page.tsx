import Link from "next/link";
import { redirect } from "next/navigation";
import { Bot, ChevronRight, Cloud, Shapes } from "lucide-react";
import { getSession, mcpEnabled, signInRedirect } from "@/lib/auth";
import { getOnshapeStatus } from "@/lib/onshape/credentials";
import { getBambuStatus } from "@/lib/bambu/credentials";
import { listMcpClients } from "@/lib/mcp/clients";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect(await signInRedirect());

  const [onshape, bambu, mcpClients] = await Promise.all([
    getOnshapeStatus(session.user.id),
    getBambuStatus(session.user.id),
    // Nothing to list when the feature is off — and the query would read
    // tables no row ever lands in.
    mcpEnabled ? listMcpClients(session.user.id) : Promise.resolve([]),
  ]);

  const connections = [
    {
      href: "/settings/onshape",
      icon: Shapes,
      title: "Onshape",
      description: "Import and sync CAD documents as .step files.",
      status: onshape,
    },
    {
      href: "/settings/bambu",
      icon: Cloud,
      title: "Bambu Cloud",
      description: "Download .3mf files when importing from MakerWorld.",
      status: bambu,
    },
    // The odd one out: this is an assistant connecting *to* the catalog, not
    // the app reaching out — so "connected" counts approved clients.
    ...(mcpEnabled
      ? [
          {
            href: "/settings/mcp",
            icon: Bot,
            title: "AI assistant access",
            description:
              "Let Claude or ChatGPT read your catalog over MCP, and revoke it again.",
            status: { connected: mcpClients.some((client) => client.active) },
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-lg font-semibold mb-3">Account</h2>
        <Card>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="text-xs text-muted-foreground">Name</div>
              <div className="text-sm font-medium">{session.user.name}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Email</div>
              <div className="text-sm font-medium">{session.user.email}</div>
            </div>
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Connections</h2>
        <div className="grid gap-3">
          {connections.map((conn) => (
            <Link key={conn.href} href={conn.href} className="group">
              <Card className="transition-colors group-hover:border-primary/50">
                <CardHeader className="flex flex-row items-center gap-3">
                  <conn.icon className="size-5 text-muted-foreground" />
                  <div className="flex-1">
                    <CardTitle className="text-base">{conn.title}</CardTitle>
                    <p className="text-sm text-muted-foreground">
                      {conn.description}
                    </p>
                  </div>
                  {conn.status.connected ? (
                    <Badge>Connected</Badge>
                  ) : (
                    <Badge variant="outline">Not connected</Badge>
                  )}
                  <ChevronRight className="size-4 text-muted-foreground" />
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
