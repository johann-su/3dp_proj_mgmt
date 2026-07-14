"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, History, Loader2, RotateCcw } from "lucide-react";
import type { ModelVersionReason } from "@/db/schema";
import { revertModelVersion } from "@/app/models/actions";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// One row of the model's edit history, precomputed server-side (see
// src/app/models/[id]/page.tsx), newest first.
export type ModelHistoryEntry = {
  versionId: number;
  number: number;
  createdAt: Date;
  editorName: string | null;
  reason: ModelVersionReason;
  summary: string;
  current: boolean;
};

const reasonLabels: Record<ModelVersionReason, string> = {
  create: "Created",
  edit: "Edited",
  "onshape-sync": "Onshape sync",
  revert: "Reverted",
};

// Edit history with per-version revert. Reverting is open to any signed-in
// user (same policy as editing) and append-only — it writes a new version
// instead of rewriting history, so a bad revert is itself revertable.
export function HistoryPanel({
  modelId,
  entries,
}: {
  modelId: string;
  entries: ModelHistoryEntry[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [revertingId, setRevertingId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  function handleRevert(entry: ModelHistoryEntry) {
    setRevertingId(entry.versionId);
    startTransition(async () => {
      const result = await revertModelVersion(modelId, entry.versionId);
      if (result?.error) {
        toast.error(result.error);
      } else {
        toast.success(`Restored version ${entry.number}.`);
        router.refresh();
      }
      setRevertingId(null);
    });
  }

  return (
    <Card className="py-4">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button className="w-full text-left" type="button">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="size-4 text-muted-foreground" />
                History ({entries.length})
                <ChevronDown
                  className={`ml-auto size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
                />
              </CardTitle>
            </CardHeader>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="grid gap-1 pt-3">
            {entries.map((entry) => (
              <div
                key={entry.versionId}
                className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm">
                    <span className="font-medium">
                      {reasonLabels[entry.reason]}
                    </span>{" "}
                    <span className="text-muted-foreground">
                      {entry.summary}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    v{entry.number}
                    {entry.editorName ? ` · ${entry.editorName}` : ""} ·{" "}
                    {formatDate(entry.createdAt)}
                    {entry.current ? " · current" : ""}
                  </div>
                </div>
                {!entry.current && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="shrink-0"
                        disabled={pending}
                        onClick={() => handleRevert(entry)}
                        aria-label={`Revert to version ${entry.number}`}
                      >
                        {revertingId === entry.versionId ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <RotateCcw className="size-4 text-muted-foreground" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      Revert to this version
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            ))}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
