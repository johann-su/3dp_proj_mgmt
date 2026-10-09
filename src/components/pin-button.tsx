"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Pin, PinOff } from "lucide-react";
import { setHomePin } from "@/app/actions";
import type { PinKind } from "@/lib/pins";
import { Button } from "@/components/ui/button";

// Pin/unpin a model or collection to the shared homepage "Pinned" section.
// Optimistic like LikeButton: flip immediately, roll back on a server error.
export function PinButton({
  kind,
  id,
  initialPinned,
}: {
  kind: PinKind;
  id: string;
  initialPinned: boolean;
}) {
  const [pinned, setPinned] = useState(initialPinned);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !pinned;
    setPinned(next);
    startTransition(async () => {
      const result = await setHomePin({ kind, id, pinned: next });
      if (result.error) {
        setPinned(!next);
        toast.error(result.error);
      } else {
        toast.success(next ? "Pinned to the homepage" : "Unpinned from the homepage");
      }
    });
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={toggle}
      disabled={pending}
      aria-pressed={pinned}
    >
      {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
      {pinned ? "Unpin" : "Pin to home"}
    </Button>
  );
}
