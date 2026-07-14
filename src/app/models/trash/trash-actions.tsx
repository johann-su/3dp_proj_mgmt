"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArchiveRestore, Trash2 } from "lucide-react";
import { deleteModelPermanently, restoreModel } from "@/app/models/actions";
import { Button, buttonVariants } from "@/components/ui/button";
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

export function TrashActions({
  modelId,
  title,
}: {
  modelId: string;
  title: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run(
    action: () => Promise<{ error?: string }>,
    successMessage: string,
  ) {
    setBusy(true);
    const result = await action();
    if (result?.error) {
      toast.error(result.error);
      setBusy(false);
    } else {
      toast.success(successMessage);
      router.refresh();
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => run(() => restoreModel(modelId), `Restored “${title}”.`)}
      >
        <ArchiveRestore className="size-4" />
        Restore
      </Button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" size="sm" disabled={busy}>
            <Trash2 className="size-4" />
            Delete permanently
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{title}” permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the model, its files and its whole version history.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                run(
                  () => deleteModelPermanently(modelId),
                  `Deleted “${title}” permanently.`,
                );
              }}
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
