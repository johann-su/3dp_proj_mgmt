"use client";

// Token management plus the plugin's setup handoff (issue #122). The handoff
// is one copyable JSON blob rather than a command line: the OrcaSlicer plugin
// is configured from its Config tab, and a JSON object is what that tab
// accepts — which also means there is no script path to get wrong, the failure
// mode that sank the post-processing-script version of this feature.

import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Loader2, Trash2 } from "lucide-react";
import { createSlicePushToken, revokeSlicePushToken } from "./push-actions";
import type { PushTokenView } from "./token-view";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function CopyButton({ label, value }: { label: string; value: string }) {
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
  );
}

export function SlicePushTokens({
  tokens: initial,
  origin,
}: {
  tokens: PushTokenView[];
  origin: string;
}) {
  const [tokens, setTokens] = useState(initial);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  // The plaintext token, held only until this page is left — the server
  // cannot show it again.
  const [fresh, setFresh] = useState<string | null>(null);

  const config = JSON.stringify(
    { url: origin, token: fresh ?? "<your token>", mode: "ask" },
    null,
    2,
  );

  async function handleCreate() {
    setCreating(true);
    const result = await createSlicePushToken(label);
    setCreating(false);
    if ("error" in result) {
      toast.error(result.error);
      return;
    }
    setFresh(result.token);
    setLabel("");
    setTokens((prev) => [result.created, ...prev]);
  }

  async function handleRevoke(tokenId: string) {
    const result = await revokeSlicePushToken(tokenId);
    if ("error" in result) {
      toast.error(result.error);
      return;
    }
    setTokens((prev) => prev.filter((t) => t.id !== tokenId));
    toast.success("Push token revoked");
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-4 pt-6">
          {fresh ? (
            <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3">
              <p className="text-sm font-medium">
                Paste this into OrcaSlicer → Plugins → Sync with Print Vault →
                ▷ Run → <em>Connect</em>:
              </p>
              <div className="flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
                  {config}
                </pre>
                <CopyButton label="Plugin config" value={config} />
              </div>
              <p className="text-xs text-muted-foreground">
                <strong>Copy it now</strong> — the token is stored hashed and
                cannot be shown again. Revoke and create a new one if you lose
                it. The plugin&rsquo;s own window keeps it in the plugin
                folder; the Config tab works too, but OrcaSlicer saves a
                plugin&rsquo;s config with your <em>print profile</em>, so a
                token entered there is moved out to the folder the first time
                the plugin runs.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="push-token-label">
                New push token{" "}
                <span className="font-normal text-muted-foreground">
                  (name the machine it goes on)
                </span>
              </Label>
              <div className="flex gap-2">
                <Input
                  id="push-token-label"
                  value={label}
                  placeholder="Workshop laptop"
                  maxLength={80}
                  onChange={(e) => setLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreate();
                  }}
                />
                <Button onClick={handleCreate} disabled={creating}>
                  {creating ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <KeyRound className="size-4" />
                  )}
                  Create
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-2">
        <p className="text-sm font-medium">Your push tokens</p>
        {tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None yet — without a token there is no push surface at all.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {tokens.map((token) => (
              <li
                key={token.id}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    {token.label ?? "Unnamed token"}{" "}
                    <code className="font-mono text-xs text-muted-foreground">
                      {token.prefix}…
                    </code>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Added {formatDate(new Date(token.createdAt))}
                    {token.lastUsedAt
                      ? ` · last used ${formatDate(new Date(token.lastUsedAt))}`
                      : " · never used"}
                  </p>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleRevoke(token.id)}
                      aria-label="Revoke this push token"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Revoke this push token</TooltipContent>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
