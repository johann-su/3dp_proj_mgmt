"use client";

// "Push from slicer" (issue #122): what the model page has to say about the
// return leg of the slicer round-trip.
//
// Deliberately not a setup form. Setup is per *machine* — install the plugin,
// paste one token — and lives in Settings; the plugin then works out which
// model a slice belongs to on its own. This dialog exists because the model
// page is where someone stands when they wonder "how do I get my tuned
// settings back in here?", and it answers that in three steps without asking
// them to configure anything per model.

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, ExternalLink, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
        {n}
      </span>
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <div className="text-sm text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

export function SlicePushDialog() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // The origin the user actually reached this page on, which is what their
  // slicer has to be able to resolve too.
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(origin);
      setCopied(true);
      toast.success("Instance URL copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy to the clipboard");
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Upload className="size-4" />
          Push from slicer
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Push from slicer</DialogTitle>
          <DialogDescription>
            Slice this model in OrcaSlicer and send the result straight back
            here as a new revision, so the catalogue keeps the settings you
            tuned instead of waiting for a manual re-upload.
          </DialogDescription>
        </DialogHeader>

        <ol className="space-y-4">
          <Step n={1} title="Install the Print Vault plugin in OrcaSlicer">
            Plugins → <em>Install local plugin</em>, and pick{" "}
            <code className="font-mono text-xs">
              orca_print_vault_plugin_any.py
            </code>{" "}
            from the Print Vault repository. Needs a build with the plugin
            system (OrcaSlicer 2.5 nightly or newer).
          </Step>
          <Step n={2} title="Point it at this instance">
            <div className="flex items-center gap-2 pt-1">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs">
                {origin}
              </code>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={handleCopy}
                    aria-label="Copy instance URL"
                  >
                    {copied ? (
                      <Check className="size-4" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Copy instance URL</TooltipContent>
              </Tooltip>
            </div>
            <p className="pt-1">
              Create a push token in{" "}
              <Link
                href="/settings/slice-push"
                className="underline underline-offset-2"
              >
                Settings → Push from slicer
              </Link>{" "}
              and paste the config it gives you into the plugin. Once per
              machine, not once per model.
            </p>
          </Step>
          <Step n={3} title="Slice a file from this model, then export it">
            OrcaSlicer only hands the result to a plugin on <em>export</em> —
            use <em>Print plate&nbsp;▾ → Export plate sliced file</em>, or send
            it to the printer. Then run <em>Plugins → Print Vault: review &amp;
            push</em> to choose what happens. Repeat pushes of the same plate
            become revisions of one file, and every one of them stays in this
            model&rsquo;s history.
          </Step>
        </ol>

        <div className="flex justify-end">
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/slice-push">
              Set up push tokens
              <ExternalLink className="size-4" />
            </Link>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
