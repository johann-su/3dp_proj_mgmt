"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Heart } from "lucide-react";
import { toggleModelLike } from "@/app/models/actions";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

// Like/favorite toggle for the model page. Optimistic like AddToCollection:
// flip the UI immediately, roll back if the server action reports an error.
export function LikeButton({
  modelId,
  initialLiked,
}: {
  modelId: string;
  initialLiked: boolean;
}) {
  const [liked, setLiked] = useState(initialLiked);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !liked;
    setLiked(next);
    startTransition(async () => {
      const result = await toggleModelLike({ modelId, liked: next });
      if (result.error) {
        setLiked(!next);
        toast.error(result.error);
      }
    });
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={toggle}
      disabled={pending}
      aria-pressed={liked}
    >
      <Heart className={cn("size-4", liked && "fill-red-500 text-red-500")} />
      {liked ? "Liked" : "Like"}
    </Button>
  );
}
