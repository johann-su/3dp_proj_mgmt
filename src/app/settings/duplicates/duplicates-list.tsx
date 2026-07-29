"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { toast } from "sonner";
import { ArrowRight, Box, Check, Trash2 } from "lucide-react";
import type { DuplicateMatch, OpenDuplicate } from "@/lib/duplicates";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatDate } from "@/lib/format";
import { dismissDuplicate, trashDuplicateModel } from "./actions";

const viaLabels: Record<OpenDuplicate["detectedVia"], string> = {
  source_url: "Same source link",
  file_hash: "Identical file",
};

export function DuplicatesList({
  duplicates,
}: {
  duplicates: OpenDuplicate[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function run(
    id: string,
    action: (id: string) => Promise<{ error?: string }>,
    success: string,
  ) {
    setBusyId(id);
    const result = await action(id);
    if (result?.error) toast.error(result.error);
    else toast.success(success);
    setBusyId(null);
    router.refresh();
  }

  if (duplicates.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        No duplicates to review.
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      {duplicates.map((dup) => (
        <div key={dup.id} className="rounded-lg border p-3">
          <div className="mb-2 flex items-center gap-2">
            <Badge variant="secondary">{viaLabels[dup.detectedVia]}</Badge>
            <span className="text-xs text-muted-foreground">
              flagged {formatDate(new Date(dup.flaggedAt))}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <ModelChip model={dup.copy} label="the copy" />
              <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
              <ModelChip model={dup.original} label="already existed" />
            </div>
            <div className="flex items-center gap-1">
              <AlertDialog>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        disabled={busyId === dup.id}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </AlertDialogTrigger>
                  </TooltipTrigger>
                  <TooltipContent>Move the copy to trash</TooltipContent>
                </Tooltip>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Move “{dup.copy.title}” to trash?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      It disappears from the library but keeps its files and
                      history, and its owner can restore it from the trash. The
                      model it duplicates is untouched.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() =>
                        run(dup.id, trashDuplicateModel, "Copy moved to trash.")
                      }
                    >
                      Move to trash
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={busyId === dup.id}
                    onClick={() =>
                      run(dup.id, dismissDuplicate, "Duplicate dismissed.")
                    }
                  >
                    <Check className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Not a duplicate — keep both, clear the flag
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// One side of the pair. Null once that model has been trashed or purged — the
// flag stays listed so a moderator can still clear it.
function ModelChip({
  model,
  label,
}: {
  model: DuplicateMatch | null;
  label: string;
}) {
  if (!model) {
    return (
      <div className="min-w-0 flex-1 text-sm text-muted-foreground">
        <span className="italic">no longer in the library</span>
        <div className="text-xs">{label}</div>
      </div>
    );
  }
  return (
    <Link
      href={`/models/${model.id}`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 transition-colors hover:bg-accent"
    >
      <div className="relative size-10 shrink-0 overflow-hidden rounded bg-muted">
        {model.coverSrc ? (
          <Image
            src={model.coverSrc}
            alt=""
            fill
            sizes="40px"
            className="object-cover"
          />
        ) : (
          <Box className="absolute inset-0 m-auto size-4 text-muted-foreground/50" />
        )}
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{model.title}</div>
        <div className="truncate text-xs text-muted-foreground">
          {label} · {model.ownerName}
        </div>
      </div>
    </Link>
  );
}
