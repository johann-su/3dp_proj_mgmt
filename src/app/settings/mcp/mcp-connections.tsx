"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bot, Check, Copy, Unplug } from "lucide-react";
import { disconnectMcpClient } from "./actions";
import { formatDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Dates cross the server/client boundary as ISO strings (a server component
// can't hand a client component a Date), and render through formatDate, which
// is pinned to UTC to keep server and client agreeing.
export type McpClientView = {
  clientId: string;
  name: string | null;
  connectedAt: string;
  lastIssuedAt: string;
  active: boolean;
};

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${label} copied`);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy to the clipboard");
    }
  }

  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-xs">
        {value}
      </code>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            onClick={handleCopy}
            aria-label={`Copy ${label.toLowerCase()}`}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Copy {label.toLowerCase()}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function McpConnections({
  endpoint,
  clients,
}: {
  endpoint: string;
  clients: McpClientView[];
}) {
  const router = useRouter();
  const [busyClientId, setBusyClientId] = useState<string | null>(null);

  async function handleDisconnect(client: McpClientView) {
    setBusyClientId(client.clientId);
    const res = await disconnectMcpClient(client.clientId);
    setBusyClientId(null);
    if (res?.error) {
      toast.error(res.error);
      return;
    }
    toast.success(`${client.name ?? "Client"} disconnected`);
    router.refresh();
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-sm font-semibold mb-2">Connecting an assistant</h2>
        <Card>
          <CardContent className="grid gap-4 py-5">
            <div className="grid gap-2">
              <div className="text-xs text-muted-foreground">
                Add this server URL in your assistant — in Claude Desktop under
                Settings → Connectors → Add custom connector, in ChatGPT as a
                custom connector.
              </div>
              <CopyField label="Server URL" value={endpoint} />
            </div>
            <div className="grid gap-2">
              <div className="text-xs text-muted-foreground">
                Or, in Claude Code:
              </div>
              <CopyField
                label="Command"
                value={`claude mcp add --transport http print-vault ${endpoint}`}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Your assistant then sends you back here to sign in and approve it.
              An approved assistant can read everything you can — every model,
              bill of materials, print estimate and manual — but cannot change
              or delete anything. Only approve a connection you just started
              yourself.
            </p>
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="text-sm font-semibold mb-2">Connected assistants</h2>
        {clients.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              Nothing connected yet.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3">
            {clients.map((client) => (
              <Card key={client.clientId}>
                <CardContent className="flex items-center gap-3 py-4">
                  <Bot className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {client.name ?? "Unnamed client"}
                      </span>
                      {!client.active && (
                        <Badge variant="outline">Expired</Badge>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      Connected {formatDate(new Date(client.connectedAt))} · last
                      signed in {formatDate(new Date(client.lastIssuedAt))}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={busyClientId === client.clientId}
                    onClick={() => handleDisconnect(client)}
                  >
                    <Unplug className="size-4" />
                    Disconnect
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
