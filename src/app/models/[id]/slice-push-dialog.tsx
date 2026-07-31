"use client";

// "Push from slicer" setup (issue #122): mint a per-model push token and hand
// the user the exact line to paste into OrcaSlicer → Print Settings → Others →
// Post-processing Scripts. The token list doubles as the revoke UI.
//
// Tokens are loaded lazily when the dialog opens rather than passed down
// through ModelViewData: the same ModelView renders the read-only version
// preview and trash pages, where there is nothing to push to.

import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Loader2, Trash2, Upload } from "lucide-react";
import {
  createSlicePushToken,
  listSlicePushTokens,
  revokeSlicePushToken,
  type PushTokenView,
} from "./push-actions";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function CopyBox({ label, value }: { label: string; value: string }) {
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
    <div className="flex items-start gap-2">
      <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
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

export function SlicePushDialog({ modelId }: { modelId: string }) {
  const [open, setOpen] = useState(false);
  const [tokens, setTokens] = useState<PushTokenView[] | null>(null);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  // The plaintext token, held only until the dialog closes — the server
  // cannot show it again.
  const [fresh, setFresh] = useState<string | null>(null);

  // The origin the user actually reached this page on, which is what their
  // slicer has to be able to resolve too.
  const endpoint =
    typeof window === "undefined"
      ? ""
      : `${window.location.origin}/api/models/${modelId}/slice-push`;

  // Loaded when the dialog opens — an event, not something to synchronize in
  // an effect.
  async function refresh() {
    const result = await listSlicePushTokens(modelId);
    if ("error" in result) {
      toast.error(result.error);
      setTokens([]);
      return;
    }
    setTokens(result.tokens);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setTokens(null);
      refresh();
    } else {
      // The plaintext token must not survive a reopen — it can't be shown
      // again anyway.
      setFresh(null);
    }
  }

  async function handleCreate() {
    setCreating(true);
    const result = await createSlicePushToken(modelId, label);
    setCreating(false);
    if ("error" in result) {
      toast.error(result.error);
      return;
    }
    setFresh(result.token);
    setLabel("");
    setTokens((prev) => [result.created, ...(prev ?? [])]);
  }

  async function handleRevoke(tokenId: string) {
    const result = await revokeSlicePushToken(tokenId);
    if ("error" in result) {
      toast.error(result.error);
      return;
    }
    setTokens((prev) => prev?.filter((t) => t.id !== tokenId) ?? null);
    toast.success("Push token revoked");
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Upload className="size-4" />
          Push from slicer
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Push from slicer</DialogTitle>
          <DialogDescription>
            Let OrcaSlicer send a file straight back to this model every time
            you slice it, so the catalogue keeps the settings you tuned instead
            of waiting for a manual re-upload.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {fresh ? (
            <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3">
              <p className="text-sm font-medium">
                Paste this into OrcaSlicer → Print Settings → Others →
                Post-processing Scripts:
              </p>
              <CopyBox
                label="Post-processing command"
                value={`python3 /path/to/slice-push.py --url "${endpoint}" --token "${fresh}";`}
              />
              <p className="text-xs text-muted-foreground">
                <strong>
                  Replace <code className="font-mono">/path/to/</code> with the real
                  path
                </strong>{" "}
                to where you saved{" "}
                <code className="font-mono">slice-push.py</code> (it ships in{" "}
                <code className="font-mono">scripts/</code> in the Print Vault
                repository) — the slicer runs the script from its own working
                directory, so a bare filename will not be found.{" "}
                <strong>Copy the token now</strong> — it is stored hashed and
                cannot be shown again.
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

          <div className="space-y-2">
            <p className="text-sm font-medium">Tokens for this model</p>
            {tokens === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : tokens.length === 0 ? (
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
                        {token.mine ? "" : " · added by someone else"}
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
      </DialogContent>
    </Dialog>
  );
}
