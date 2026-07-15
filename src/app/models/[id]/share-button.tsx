"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// Copies the current model page's URL to the clipboard. Uses
// window.location.href so the link always matches what the viewer is looking
// at (canonical /models/{id}), without threading the origin down from the
// server.
export function ShareButton() {
  const [copied, setCopied] = useState(false);

  async function handleShare() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      toast.success("Link copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy the link");
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={handleShare}>
      {copied ? <Check className="size-4" /> : <Share2 className="size-4" />}
      Share
    </Button>
  );
}
