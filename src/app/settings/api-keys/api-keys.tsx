"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { KeyRound, Trash2 } from "lucide-react";
import { createApiKey, deleteApiKey } from "./actions";
import { formatDate } from "@/lib/format";
import {
  ALL_SCOPES,
  READ_ONLY_SCOPES,
  type ApiScope,
} from "@/lib/api/scopes";
import { CopyField } from "@/components/copy-field";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

// Dates cross the server/client boundary as ISO strings and render through formatDate, which is pinned to UTC so server and client agree.
export type ApiKeyView = {
  id: string;
  name: string | null;
  start: string | null;
  scopes: ApiScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  // Decided on the server, against one clock, so render stays pure.
  expired: boolean;
};

const EXPIRY_OPTIONS = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never" },
];

function KeyRow({ apiKey }: { apiKey: ApiKeyView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const { expired } = apiKey;

  async function handleRevoke() {
    setBusy(true);
    const res = await deleteApiKey(apiKey.id);
    setBusy(false);
    if (res?.error) return void toast.error(res.error);
    toast.success(`${apiKey.name ?? "Key"} revoked`);
    router.refresh();
  }

  return (
    <Card>
      <CardContent className="flex items-start gap-3 py-4">
        <KeyRound className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 grid gap-1.5">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{apiKey.name ?? "Unnamed key"}</span>
            {apiKey.start && (
              <code className="text-xs text-muted-foreground">{apiKey.start}…</code>
            )}
            {expired && <Badge variant="outline">Expired</Badge>}
          </div>
          <div className="flex flex-wrap gap-1">
            {apiKey.scopes.length === 0 ? (
              <Badge variant="outline">No scopes</Badge>
            ) : (
              apiKey.scopes.map((scope) => (
                <Badge key={scope} variant="secondary" className="font-mono text-[11px]">
                  {scope}
                </Badge>
              ))
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            Created {formatDate(new Date(apiKey.createdAt))} ·{" "}
            {apiKey.lastUsedAt
              ? `last used ${formatDate(new Date(apiKey.lastUsedAt))}`
              : "never used"}{" "}
            ·{" "}
            {apiKey.expiresAt
              ? `${expired ? "expired" : "expires"} ${formatDate(new Date(apiKey.expiresAt))}`
              : "never expires"}
          </div>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" className="shrink-0" disabled={busy}>
              <Trash2 className="size-4" />
              Revoke
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke {apiKey.name ?? "this key"}?</AlertDialogTitle>
              <AlertDialogDescription>
                Anything using it stops working immediately. This can&apos;t be
                undone — create a new key to reconnect.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className={buttonVariants({ variant: "destructive" })}
                onClick={handleRevoke}
              >
                Revoke key
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

export function ApiKeys({
  apiBase,
  scopes,
  keys,
}: {
  apiBase: string;
  scopes: { scope: ApiScope; description: string }[];
  keys: ApiKeyView[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<ApiScope[]>(READ_ONLY_SCOPES);
  const [expiry, setExpiry] = useState("90");
  const [busy, setBusy] = useState(false);
  // The secret of the key just created — shown once, then gone for good.
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);

  function toggle(scope: ApiScope, on: boolean) {
    setSelected((prev) =>
      on ? ALL_SCOPES.filter((s) => s === scope || prev.includes(s)) : prev.filter((s) => s !== scope),
    );
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await createApiKey({
      name,
      scopes: selected,
      expiresInDays: expiry === "never" ? null : Number(expiry),
    });
    setBusy(false);
    if ("error" in res) return void toast.error(res.error);
    setCreated({ name: name.trim(), key: res.key });
    setName("");
    router.refresh();
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-sm font-semibold mb-2">Using the API</h2>
        <Card>
          <CardContent className="grid gap-4 py-5">
            <div className="grid gap-2">
              <div className="text-xs text-muted-foreground">Base URL</div>
              <CopyField label="Base URL" value={apiBase} />
            </div>
            <div className="grid gap-2">
              <div className="text-xs text-muted-foreground">
                Send the key as a bearer token. The OpenAPI description at{" "}
                <a className="underline" href={`${apiBase}/openapi.json`}>
                  /api/v1/openapi.json
                </a>{" "}
                lists every endpoint.
              </div>
              <CopyField
                label="Example"
                value={`curl -H "Authorization: Bearer pv_…" ${apiBase}/models`}
              />
            </div>
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="text-sm font-semibold mb-2">Create a key</h2>
        <Card>
          <CardContent className="py-5">
            {created ? (
              <div className="grid gap-3">
                <p className="text-sm">
                  <span className="font-medium">{created.name}</span> is ready. Copy it
                  now — it won&apos;t be shown again.
                </p>
                <CopyField label="API key" value={created.key} />
                <Button
                  variant="outline"
                  size="sm"
                  className="justify-self-start"
                  onClick={() => setCreated(null)}
                >
                  Done
                </Button>
              </div>
            ) : (
              <form onSubmit={handleCreate} className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="api-key-name">Name</Label>
                  <Input
                    id="api-key-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="n8n workflows"
                    maxLength={64}
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <div className="flex items-center gap-2">
                    <Label>Scopes</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-7"
                      onClick={() => setSelected(READ_ONLY_SCOPES)}
                    >
                      Read only
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7"
                      onClick={() => setSelected(ALL_SCOPES)}
                    >
                      Everything
                    </Button>
                  </div>
                  <div className="grid gap-2 rounded-lg border p-3">
                    {scopes.map(({ scope, description }) => (
                      <label key={scope} className="flex items-start gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selected.includes(scope)}
                          onChange={(e) => toggle(scope, e.target.checked)}
                          className="mt-0.5 size-4 accent-primary"
                        />
                        <span className="grid gap-0.5">
                          <code className="text-xs font-medium">{scope}</code>
                          <span className="text-xs text-muted-foreground">{description}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    <code>files:read</code> downloads model files themselves —
                    leave it off for integrations that only need metadata.
                  </p>
                </div>
                <div className="grid gap-2">
                  <Label>Expires</Label>
                  <Select value={expiry} onValueChange={setExpiry}>
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EXPIRY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  type="submit"
                  className="justify-self-start"
                  disabled={busy || !name.trim() || selected.length === 0}
                >
                  {busy ? "Creating…" : "Create key"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="text-sm font-semibold mb-2">Your keys</h2>
        {keys.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              No keys yet.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3">
            {keys.map((apiKey) => (
              <KeyRow key={apiKey.id} apiKey={apiKey} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
