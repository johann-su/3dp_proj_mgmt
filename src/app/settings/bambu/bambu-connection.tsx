"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Cloud, RefreshCw, Unplug } from "lucide-react";
import {
  disconnectBambu,
  finishBambuCode,
  finishBambuTfa,
  saveBambuToken,
  startBambuLogin,
} from "./actions";
import type { BambuConnectionStatus } from "@/lib/bambu/credentials";
import { formatDaysLeft } from "@/lib/bambu/token-expiry";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Mode = "login" | "token";
type Step = "credentials" | "code" | "tfa";

export function BambuConnection({ status }: { status: BambuConnectionStatus }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [step, setStep] = useState<Step>("credentials");
  const [busy, setBusy] = useState(false);
  // Re-login over an existing connection (Bambu tokens can't be refreshed
  // silently — see src/lib/bambu/token-expiry.ts).
  const [renewing, setRenewing] = useState(false);

  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [region, setRegion] = useState("global");
  const [code, setCode] = useState("");
  const [tfaKey, setTfaKey] = useState("");
  const [tfaCode, setTfaCode] = useState("");
  const [token, setToken] = useState("");

  function connected() {
    toast.success(renewing ? "Bambu Cloud login renewed" : "Bambu Cloud connected");
    setRenewing(false);
    setStep("credentials");
    setPassword("");
    setCode("");
    setTfaCode("");
    router.refresh();
  }

  function startRenew() {
    setAccount(status.account ?? "");
    setRegion(status.region ?? "global");
    setMode("login");
    setStep("credentials");
    setRenewing(true);
  }

  async function handleDisconnect() {
    setBusy(true);
    const res = await disconnectBambu();
    setBusy(false);
    if (res?.error) {
      toast.error(res.error);
      return;
    }
    toast.success("Disconnected");
    router.refresh();
  }

  if (status.connected && !renewing) {
    const needsRenewal = status.state === "expired" || status.state === "expiring";
    return (
      <Card>
        <CardContent className="grid gap-4 py-4">
          <div className="flex items-center gap-3">
            {needsRenewal ? (
              <AlertTriangle
                className={
                  "size-5 shrink-0 " +
                  (status.state === "expired" ? "text-destructive" : "text-amber-500")
                }
              />
            ) : (
              <CheckCircle2 className="size-5 text-primary shrink-0" />
            )}
            <div className="min-w-0">
              <div className="text-sm font-medium">
                {status.state === "expired"
                  ? "Login expired"
                  : status.state === "expiring"
                    ? "Login expires soon"
                    : "Connected"}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {status.account} · {status.region === "china" ? "China" : "Global"}
                {status.expiresAt && status.state !== "expired" && (
                  <> · expires {new Date(status.expiresAt).toLocaleDateString()}</>
                )}
              </div>
            </div>
            <div className="ml-auto flex shrink-0 gap-2">
              <Button
                variant={needsRenewal ? "default" : "outline"}
                size="sm"
                disabled={busy}
                onClick={startRenew}
              >
                <RefreshCw className="size-4" />
                Renew login
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={handleDisconnect}
              >
                <Unplug className="size-4" />
                Disconnect
              </Button>
            </div>
          </div>
          {needsRenewal && (
            <p className="text-xs text-muted-foreground">
              {status.state === "expired"
                ? "Bambu no longer accepts this login, so MakerWorld imports and syncs can't download files. Log in again to renew it."
                : `This login expires in ${formatDaysLeft(status.daysLeft ?? 0)}. Renew it now to keep MakerWorld downloads working.`}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  async function handleStart(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const res = await startBambuLogin({ account, password, region });
    setBusy(false);
    if ("error" in res) {
      toast.error(res.error);
      return;
    }
    if (res.status === "connected") return connected();
    if (res.status === "needCode") {
      setStep("code");
      toast.message("Enter the verification code sent to your email");
    } else if (res.status === "needTfa") {
      setTfaKey(res.tfaKey);
      setStep("tfa");
    }
  }

  async function handleCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const res = await finishBambuCode({ account, code, region });
    setBusy(false);
    if ("error" in res) return void toast.error(res.error);
    connected();
  }

  async function handleTfa(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const res = await finishBambuTfa({ account, tfaKey, tfaCode, region });
    setBusy(false);
    if ("error" in res) return void toast.error(res.error);
    connected();
  }

  async function handleToken(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const res = await saveBambuToken({ account, token, region });
    setBusy(false);
    if ("error" in res) return void toast.error(res.error);
    connected();
  }

  const regionSelect = (
    <div className="grid gap-2">
      <Label>Region</Label>
      <Select value={region} onValueChange={setRegion}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="global">Global (bambulab.com)</SelectItem>
          <SelectItem value="china">China (bambulab.cn)</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <Card>
      <CardContent className="grid gap-4 py-5">
        {renewing && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">
              Log in again to renew the connection for {status.account}.
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              disabled={busy}
              onClick={() => setRenewing(false)}
            >
              Cancel
            </Button>
          </div>
        )}
        <div className="flex gap-1 rounded-lg bg-muted p-1 text-sm">
          {(
            [
              ["login", "Log in"],
              ["token", "Paste token"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setMode(value);
                setStep("credentials");
              }}
              className={
                "flex-1 rounded-md px-3 py-1.5 " +
                (mode === value
                  ? "bg-background shadow-sm font-medium"
                  : "text-muted-foreground")
              }
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "login" && step === "credentials" && (
          <form onSubmit={handleStart} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="bambu-account">Bambu account email</Label>
              <Input
                id="bambu-account"
                type="email"
                required
                autoComplete="off"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bambu-password">Password</Label>
              <Input
                id="bambu-password"
                type="password"
                required
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {regionSelect}
            <Button type="submit" disabled={busy}>
              <Cloud className="size-4" />
              {busy ? "Connecting…" : "Connect"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Your credentials are sent to Bambu Cloud to obtain an access token;
              only the token is stored (encrypted), never your password.
            </p>
          </form>
        )}

        {mode === "login" && step === "code" && (
          <form onSubmit={handleCode} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="bambu-code">Email verification code</Label>
              <Input
                id="bambu-code"
                inputMode="numeric"
                required
                autoComplete="one-time-code"
                placeholder="6-digit code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Sent to {account}.
              </p>
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? "Verifying…" : "Verify & connect"}
            </Button>
          </form>
        )}

        {mode === "login" && step === "tfa" && (
          <form onSubmit={handleTfa} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="bambu-tfa">Authenticator code</Label>
              <Input
                id="bambu-tfa"
                inputMode="numeric"
                required
                autoComplete="one-time-code"
                placeholder="6-digit code"
                value={tfaCode}
                onChange={(e) => setTfaCode(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                From your authenticator app (two-factor authentication).
              </p>
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? "Verifying…" : "Verify & connect"}
            </Button>
          </form>
        )}

        {mode === "token" && (
          <form onSubmit={handleToken} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="bambu-token-account">Bambu account email</Label>
              <Input
                id="bambu-token-account"
                type="email"
                required
                autoComplete="off"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bambu-token">Access token</Label>
              <Input
                id="bambu-token"
                required
                autoComplete="off"
                placeholder="eyJhbGc…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The <code>token</code> cookie from a signed-in MakerWorld browser
                session (DevTools → Application → Cookies).
              </p>
            </div>
            {regionSelect}
            <Button type="submit" disabled={busy}>
              <Cloud className="size-4" />
              {busy ? "Saving…" : "Save token"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
