import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getOnshapeStatus } from "@/lib/onshape/credentials";
import { onshapeOAuthEnabled, onshapeRedirectUri } from "@/lib/onshape/oauth";
import { OnshapeConnection } from "./onshape-connection";

export const dynamic = "force-dynamic";

// Human-readable variants of the ?error= codes set by the OAuth routes.
const ERRORS: Record<string, string> = {
  denied: "Onshape access was declined — nothing was connected.",
  "state-mismatch":
    "The sign-in attempt could not be verified (state mismatch) — try again.",
  "connect-failed": "Connecting to Onshape failed — try again in a moment.",
  "not-configured":
    "Onshape sign-in is not configured on this server (see below).",
};

export default async function OnshapeSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/sign-in");

  const [status, { error }] = await Promise.all([
    getOnshapeStatus(session.user.id),
    searchParams,
  ]);

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <h1 className="text-2xl font-semibold mb-1">Onshape connection</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Sign in with your Onshape account to import models from
        cad.onshape.com (documents are exported as <code>.step</code> files),
        keep them in sync when the document changes, and jump back into the
        Onshape editor from a model page.
      </p>
      {error && (
        <p className="text-sm text-destructive mb-4">
          {ERRORS[error] ?? "Connecting to Onshape failed."}
        </p>
      )}
      <OnshapeConnection
        status={status}
        configured={onshapeOAuthEnabled}
        redirectUri={onshapeRedirectUri()}
      />
    </div>
  );
}
