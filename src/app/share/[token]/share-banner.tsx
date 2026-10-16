import Link from "next/link";
import { Globe } from "lucide-react";
import { Button } from "@/components/ui/button";

// Strip above every public share page. Anonymous visitors get a sign-in
// prompt; a signed-in member who opened a public link gets a way back to the
// full catalog page (with editing, history, customizer, slicer links).
export function ShareBanner({
  signedIn,
  catalogHref,
}: {
  signedIn: boolean;
  catalogHref: string;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-muted/40 px-4 py-2.5 text-sm">
      <Globe className="size-4 shrink-0 text-muted-foreground" />
      <span className="text-muted-foreground">
        {signedIn
          ? "You're viewing the public link — this is what visitors without an account see."
          : "Shared with you via a public link. You can view and download without an account."}
      </span>
      <Button asChild variant="outline" size="sm" className="ml-auto">
        <Link href={signedIn ? catalogHref : "/sign-in"}>
          {signedIn ? "Open in catalog" : "Sign in"}
        </Link>
      </Button>
    </div>
  );
}
