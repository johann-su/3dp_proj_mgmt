"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, KeyRound, Unplug } from "lucide-react";
import { connectOnshape, disconnectOnshape } from "./actions";
import type { OnshapeConnectionStatus } from "@/lib/onshape/credentials";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

export function OnshapeConnection({ status }: { status: OnshapeConnectionStatus }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");

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
              {status.account} · key {status.accessKey?.slice(0, 8)}…
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

  async function handleConnect(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const res = await connectOnshape({ accessKey, secretKey });
    setBusy(false);
    if ("error" in res) {
      toast.error(res.error);
      return;
    }
    toast.success("Onshape connected");
    router.refresh();
  }

  return (
    <Card>
      <CardContent className="py-5">
        <form onSubmit={handleConnect} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="onshape-access-key">Access key</Label>
            <Input
              id="onshape-access-key"
              required
              autoComplete="off"
              value={accessKey}
              onChange={(e) => setAccessKey(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="onshape-secret-key">Secret key</Label>
            <Input
              id="onshape-secret-key"
              type="password"
              required
              autoComplete="off"
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy}>
            <KeyRound className="size-4" />
            {busy ? "Checking key…" : "Connect"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Create an API key at{" "}
            <a
              href="https://dev-portal.onshape.com/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              dev-portal.onshape.com/keys
            </a>{" "}
            with at least the <em>Read</em> scope. The secret key is stored
            encrypted and is only used to read and export your documents.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
