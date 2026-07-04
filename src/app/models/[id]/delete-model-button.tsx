"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { deleteModel } from "@/app/models/actions";
import { isNextRedirectError } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function DeleteModelButton({ modelId }: { modelId: string }) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!confirm("Delete this model and all its files? This cannot be undone.")) {
      return;
    }
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
    <Button
      variant="destructive"
      size="sm"
      onClick={handleDelete}
      disabled={deleting}
    >
      <Trash2 className="size-4" />
      {deleting ? "Deleting…" : "Delete model"}
    </Button>
  );
}
