import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { Plug, ShieldCheck } from "lucide-react";
import { db } from "@/db";
import { oauthApplication } from "@/db/schema";
import { getSession, mcpEnabled, signInRedirect } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const dynamic = "force-dynamic";

// The approval screen an MCP client's browser lands on — the
// `authorization_endpoint` advertised in /.well-known/oauth-authorization-server
// (see that route for why it isn't BetterAuth's own endpoint). It shows who is
// asking and what they get, then forwards the untouched OAuth query to
// /api/auth/mcp/authorize, which mints the code and redirects to the client.
//
// Approving here grants the client the *same read access the user has in the
// browser* — the catalog is private but not further partitioned (see
// docs/architecture/auth-and-access.md), so there is nothing finer to consent
// to. It is a transparency screen, not a permission boundary: a user who is
// already signed in can reach BetterAuth's endpoint directly, so this cannot
// be relied on to stop a crafted authorize link. The real control is that the
// whole MCP surface is off unless the operator sets ENABLE_MCP.

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function Problem({ title, detail }: { title: string; detail: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{detail}</CardDescription>
      </CardHeader>
    </Card>
  );
}

export default async function McpAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!mcpEnabled) notFound();

  const params = await searchParams;
  const session = await getSession();
  // The proxy hands the page its own path+query as x-callback-path, so signing
  // in returns here with the OAuth request intact.
  if (!session) redirect(await signInRedirect());

  const clientId = first(params.client_id);
  const redirectUri = first(params.redirect_uri);
  const client = clientId
    ? await db.query.oauthApplication.findFirst({
        where: eq(oauthApplication.clientId, clientId),
      })
    : undefined;

  if (!client || client.disabled) {
    return (
      <Problem
        title="Unknown client"
        detail="This connection request doesn't match any registered MCP client. Start the connection again from your MCP client."
      />
    );
  }
  // Never forward a redirect_uri the client didn't register: the code would be
  // handed to whoever crafted the link. BetterAuth checks this again.
  if (!redirectUri || !client.redirectUrls.split(",").includes(redirectUri)) {
    return (
      <Problem
        title="Invalid redirect URL"
        detail="The address this request wants to be sent back to is not one the client registered."
      />
    );
  }

  // Forward every parameter the client sent (PKCE challenge, state, scope, …)
  // unchanged — this page reads the request, it does not rewrite it.
  const forward = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const single = first(value);
    if (single !== undefined) forward.set(key, single);
  }

  const denied = new URL(redirectUri);
  denied.searchParams.set("error", "access_denied");
  const state = first(params.state);
  if (state) denied.searchParams.set("state", state);

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plug className="size-5" />
            Connect {client.name || "an MCP client"}
          </CardTitle>
          <CardDescription>
            {client.name || "This client"} wants to read your Print Vault
            catalog on your behalf.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="rounded-md border p-3 text-sm text-muted-foreground">
            <p className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" />
              <span>
                It can read models, bills of materials, print estimates and
                manuals — the same things you can see when signed in. It cannot
                create, edit or delete anything.
              </span>
            </p>
            <p className="mt-2 break-all">
              Responses go to <span className="font-mono">{denied.origin}</span>
            </p>
          </div>
          <div className="flex gap-2">
            {/* Plain links, not a form: the approval hop ends in a redirect to
                another origin, which the CSP's form-action 'self' would fight. */}
            <Button asChild className="flex-1">
              <a href={`/api/auth/mcp/authorize?${forward}`}>Allow</a>
            </Button>
            <Button asChild variant="outline" className="flex-1">
              <a href={denied.toString()}>Cancel</a>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
