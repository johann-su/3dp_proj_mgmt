"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, Copy, Globe, Loader2, Lock, Share2 } from "lucide-react";
import { setPublicShare } from "@/app/share/actions";
import type { ShareKind } from "@/lib/share-links";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

// The model/collection "Share" dialog. The members link (the page's own URL,
// sign-in required) is always there; below it, owners can switch on a public
// link that works without an account, and anyone signed in can switch it off
// again — see setPublicShare for why that's asymmetric. URLs are built from
// window.location.origin, like the old copy-only button, so they match the
// host the viewer is on without threading the origin down from the server.
export function ShareButton({
  kind,
  id,
  initialToken,
  canEnable,
  publicSharingAvailable,
  smart = false,
}: {
  kind: ShareKind;
  id: string;
  // The live public-link token, or null while the item is private.
  initialToken: string | null;
  // Viewer may create a public link (owner or moderator/admin).
  canEnable: boolean;
  // False when the operator set DISABLE_PUBLIC_SHARING.
  publicSharingAvailable: boolean;
  // Smart collections gain members by rule — worth a warning before going
  // public.
  smart?: boolean;
}) {
  const [token, setToken] = useState(initialToken);
  const [pending, startTransition] = useTransition();
  const noun = kind === "model" ? "model" : "collection";

  function toggle(enabled: boolean) {
    startTransition(async () => {
      const result = await setPublicShare({ kind, id, enabled });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setToken(result.token);
      toast.success(
        result.token ? "Public link created" : "Public link revoked",
      );
    });
  }

  const isPublic = token !== null;
  // Non-owners can see the option (and revoke a live link) but not create
  // one — say so where they're looking, not in a footnote.
  const locked = !isPublic && !canEnable;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {isPublic ? <Globe className="size-4" /> : <Share2 className="size-4" />}
          Share
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share {noun}</DialogTitle>
          <DialogDescription>
            By default only signed-in members of this instance can open the
            link.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Lock className="size-3.5 text-muted-foreground" />
            Members link
          </div>
          <CopyField path={`/${kind}s/${id}`} label="members link" />
        </div>

        {publicSharingAvailable ? (
          <>
            <Separator />
            <div className="grid gap-3">
              <label
                className={
                  locked
                    ? "flex cursor-not-allowed items-start gap-3 opacity-60"
                    : "flex cursor-pointer items-start gap-3"
                }
              >
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary disabled:cursor-not-allowed"
                  checked={isPublic}
                  disabled={pending || locked}
                  onChange={(e) => toggle(e.target.checked)}
                />
                <span className="grid gap-1">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    Anyone with the link can view
                    {pending && <Loader2 className="size-3.5 animate-spin" />}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {kind === "model"
                      ? "No account needed. Visitors see the description, images and 3D preview, and can download its files."
                      : "No account needed. Visitors see the collection and every model in it, and can download their files."}
                  </span>
                  {locked && (
                    <span className="flex items-center gap-1 text-xs font-medium">
                      <Lock className="size-3" />
                      Only the {noun}&apos;s owner or a moderator can turn this on.
                    </span>
                  )}
                </span>
              </label>

              {smart && !locked && (
                <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  This is a smart collection: models that start matching its
                  rules later become visible through the link too.
                </p>
              )}

              {isPublic && (
                <CopyField path={`/share/${token}`} label="public link" />
              )}

              {!locked && (
                <p className="text-xs text-muted-foreground">
                  Turning this off invalidates the link immediately; turning it
                  on again creates a new one.
                </p>
              )}
            </div>
          </>
        ) : (
          isPublic && (
            <p className="text-xs text-muted-foreground">
              Public links are disabled on this instance, so this {noun}&apos;s
              public link is not being served.
            </p>
          )
        )}
      </DialogContent>
    </Dialog>
  );
}

// Read-only URL with a copy button. Rendered only inside the open dialog, so
// reading window.location here can't cause a hydration mismatch.
function CopyField({ path, label }: { path: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}${path}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Link copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy the link");
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        readOnly
        value={url}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        className="font-mono text-xs"
      />
      <Button variant="outline" size="sm" onClick={copy}>
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        Copy
      </Button>
    </div>
  );
}
