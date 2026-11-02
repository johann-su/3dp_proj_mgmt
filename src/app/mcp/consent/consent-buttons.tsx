"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { answerConsent } from "./actions";

export function ConsentButtons({ oauthQuery }: { oauthQuery: string }) {
  const [busy, setBusy] = useState(false);

  async function answer(accept: boolean) {
    setBusy(true);
    const result = await answerConsent({ oauthQuery, accept });
    if (result.url) {
      window.location.assign(result.url);
      return;
    }
    setBusy(false);
    toast.error(result.error ?? "Something went wrong");
  }

  return (
    <div className="flex gap-2">
      <Button className="flex-1" disabled={busy} onClick={() => answer(true)}>
        Allow
      </Button>
      <Button
        variant="outline"
        className="flex-1"
        disabled={busy}
        onClick={() => answer(false)}
      >
        Cancel
      </Button>
    </div>
  );
}
