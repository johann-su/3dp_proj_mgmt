"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, LogIn, Unplug } from "lucide-react";
import { disconnectOnshape } from "./actions";
import type { OnshapeConnectionStatus } from "@/lib/onshape/credentials";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function OnshapeConnection({
  status,
  configured,
  redirectUri,
}: {
  status: OnshapeConnectionStatus;
  configured: boolean;
  redirectUri: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleDisconnect() {
    setBusy(true);
    const res = await disconnectOnshape();
    setBusy(false);
    if (res?.error) {
      toast.error(res.error);
      return;
    }
    toast.success("Disconnected");
    router.refresh();
  }

  if (status.connected) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-4">
          <CheckCircle2 className="size-5 text-primary shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-medium">Connected</div>
            <div className="text-xs text-muted-foreground truncate">
              {status.account}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto shrink-0"
            disabled={busy}
            onClick={handleDisconnect}
          >
            <Unplug className="size-4" />
            Disconnect
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!configured) {
    return (
      <Card>
        <CardContent className="py-5 grid gap-2 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">
            Onshape sign-in is not configured on this server.
          </p>
          <p>
            The administrator needs to create an OAuth application at{" "}
            <a
              href="https://dev-portal.onshape.com/oauthApps"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              dev-portal.onshape.com
            </a>{" "}
            with the redirect URL <code className="break-all">{redirectUri}</code>{" "}
            and permission to read documents and profile information, then set{" "}
            <code>ONSHAPE_CLIENT_ID</code> and <code>ONSHAPE_CLIENT_SECRET</code>.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="py-5 grid gap-4">
        <Button asChild className="justify-self-start">
          <a href="/api/onshape/authorize">
            <LogIn className="size-4" />
            Sign in with Onshape
          </a>
        </Button>
        <p className="text-xs text-muted-foreground">
          You will be sent to Onshape to approve read access to your documents.
          Only the resulting tokens are stored (encrypted) — never your Onshape
          password. Disconnect here at any time.
        </p>
      </CardContent>
    </Card>
  );
}
