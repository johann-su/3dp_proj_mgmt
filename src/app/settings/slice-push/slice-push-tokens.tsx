"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { revokeSlicePushToken } from "@/app/models/[id]/push-actions";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Dates cross the server/client boundary as ISO strings — see McpClientView.
export type SlicePushTokenView = {
  id: string;
  prefix: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  modelId: string;
  modelTitle: string;
};

export function SlicePushTokens({ tokens }: { tokens: SlicePushTokenView[] }) {
  const [revoked, setRevoked] = useState<Set<string>>(new Set());

  async function handleRevoke(tokenId: string) {
    const result = await revokeSlicePushToken(tokenId);
    if ("error" in result) {
      toast.error(result.error);
      return;
    }
    setRevoked((prev) => new Set(prev).add(tokenId));
    toast.success("Push token revoked");
  }

  const live = tokens.filter((token) => !revoked.has(token.id));

  if (live.length === 0) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          You have no push tokens. Open a model and choose{" "}
          <strong>Push from slicer</strong> to create one.
        </CardContent>
      </Card>
    );
  }

  return (
    <ul className="divide-y rounded-md border">
      {live.map((token) => (
        <li
          key={token.id}
          className="flex items-center justify-between gap-3 px-3 py-3"
        >
          <div className="min-w-0">
            <p className="truncate text-sm">
              <Link
                href={`/models/${token.modelId}`}
                className="font-medium hover:underline"
              >
                {token.modelTitle}
              </Link>{" "}
              <span className="text-muted-foreground">
                {token.label ?? "Unnamed token"}
              </span>{" "}
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
                aria-label={`Revoke the push token for ${token.modelTitle}`}
              >
                <Trash2 className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Revoke this push token</TooltipContent>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}
