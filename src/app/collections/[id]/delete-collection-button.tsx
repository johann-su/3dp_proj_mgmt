"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { deleteCollection } from "@/app/collections/actions";
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

export function DeleteCollectionButton({ collectionId }: { collectionId: string }) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      // Redirects to /collections on success.
      const result = await deleteCollection(collectionId);
      if (result?.error) {
        toast.error(result.error);
        setDeleting(false);
      }
    } catch (err) {
      if (isNextRedirectError(err)) return;
      toast.error("Failed to delete collection");
      setDeleting(false);
    }
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm" disabled={deleting}>
          <Trash2 className="size-4" />
          {deleting ? "Deleting…" : "Delete collection"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this collection?</AlertDialogTitle>
          <AlertDialogDescription>
            This deletes the collection. The models in it are not deleted.
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
            {deleting ? "Deleting…" : "Delete collection"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
