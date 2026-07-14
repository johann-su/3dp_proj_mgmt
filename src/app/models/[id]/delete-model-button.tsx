"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { deleteModel } from "@/app/models/actions";
import { isNextRedirectError } from "@/lib/utils";
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

export function DeleteModelButton({ modelId }: { modelId: string }) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      // Redirects to the homepage on success.
      const result = await deleteModel(modelId);
      if (result?.error) {
        toast.error(result.error);
        setDeleting(false);
      }
    } catch (err) {
      if (isNextRedirectError(err)) return;
      toast.error("Failed to delete model");
      setDeleting(false);
    }
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm" disabled={deleting}>
          <Trash2 className="size-4" />
          {deleting ? "Deleting…" : "Delete model"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this model?</AlertDialogTitle>
          <AlertDialogDescription>
            The model moves to your trash and disappears from the library. You
            can restore it from the trash for 30 days; after that it is deleted
            permanently.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            // Deletion redirects, so keep the dialog open until it resolves.
            onClick={(e) => {
              e.preventDefault();
              handleDelete();
            }}
            disabled={deleting}
          >
            {deleting ? "Deleting…" : "Delete model"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
