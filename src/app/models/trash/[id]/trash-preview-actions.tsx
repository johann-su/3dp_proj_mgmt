"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArchiveRestore, ArrowLeft, Trash2 } from "lucide-react";
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

// Restore/purge controls for the trash preview header. Same actions as the
// trash list rows (restoreModel / deleteModelPermanently), but with explicit
// navigation instead of a refresh: restoring makes the model live (so this
// preview would notFound), and purging destroys it — either way we leave the
// page rather than re-render a model that is no longer here.
export function TrashPreviewActions({
  modelId,
  title,
}: {
  modelId: string;
  title: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleRestore() {
    setBusy(true);
    const result = await restoreModel(modelId);
    if (result?.error) {
      toast.error(result.error);
      setBusy(false);
    } else {
      toast.success(`Restored “${title}”.`);
      router.push(`/models/${modelId}`);
      router.refresh();
    }
  }

  async function handlePurge() {
    setBusy(true);
    const result = await deleteModelPermanently(modelId);
    if (result?.error) {
      toast.error(result.error);
      setBusy(false);
    } else {
      toast.success(`Deleted “${title}” permanently.`);
      router.push("/models/trash");
      router.refresh();
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      <Button asChild variant="outline" size="sm">
        <Link href="/models/trash">
          <ArrowLeft className="size-4" />
          Back to trash
        </Link>
      </Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={handleRestore}>
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
                handlePurge();
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
