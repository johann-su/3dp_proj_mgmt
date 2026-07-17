"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, RotateCcw } from "lucide-react";
import { revertModelVersion } from "@/app/models/actions";
import { Button } from "@/components/ui/button";

// Restores the previewed version and returns to the model page. Same policy
// and mechanics as the History panel's revert: open to any signed-in user,
// append-only (the restore itself becomes a new version).
export function RestoreVersionButton({
  modelId,
  versionId,
  number,
}: {
  modelId: string;
  versionId: number;
  number: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [restoring, setRestoring] = useState(false);

  function handleRestore() {
    setRestoring(true);
    startTransition(async () => {
      const result = await revertModelVersion(modelId, versionId);
      if (result?.error) {
        toast.error(result.error);
        setRestoring(false);
      } else {
        toast.success(`Restored version ${number}.`);
        router.push(`/models/${modelId}`);
        router.refresh();
      }
    });
  }

  return (
    <Button size="sm" disabled={pending || restoring} onClick={handleRestore}>
      {restoring ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <RotateCcw className="size-4" />
      )}
      Restore this version
    </Button>
  );
}
