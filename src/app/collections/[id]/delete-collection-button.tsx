"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { deleteCollection } from "@/app/collections/actions";
import { isNextRedirectError } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function DeleteCollectionButton({ collectionId }: { collectionId: string }) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!confirm("Delete this collection? The models in it are not deleted.")) {
      return;
    }
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
    <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleting}>
      <Trash2 className="size-4" />
      {deleting ? "Deleting…" : "Delete collection"}
    </Button>
  );
}
