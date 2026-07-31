import { redirect } from "next/navigation";
import { getSession, signInRedirect } from "@/lib/auth";
import { listUserPushTokens } from "@/lib/model-push-tokens";
import { SlicePushTokens } from "./slice-push-tokens";

export const dynamic = "force-dynamic";

// Every slice-push token the signed-in user has issued, across all models —
// the place to cut one off when you no longer remember which model it belonged
// to, or when the machine holding it is gone. Minting happens on the model
// page (issue #122), since a token is meaningless without its model.
export default async function SlicePushSettingsPage() {
  const session = await getSession();
  if (!session) redirect(await signInRedirect());

  const tokens = await listUserPushTokens(session.user.id);

  return (
    <div className="max-w-2xl">
      <h1 className="text-lg font-semibold mb-1">Slicer push tokens</h1>
      <p className="text-sm text-muted-foreground mb-6">
        A push token lets a post-processing script in OrcaSlicer, Bambu Studio
        or PrusaSlicer send a freshly sliced file back to one model as a new
        revision, without a login. Each token is scoped to a single model and
        grants the same editing access you already have on it — revoke one here
        the moment the machine holding it is out of your hands. Create tokens
        from a model page, under <strong>Push from slicer</strong>.
      </p>
      <SlicePushTokens
        tokens={tokens.map((token) => ({
          ...token,
          createdAt: token.createdAt.toISOString(),
          lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
        }))}
      />
    </div>
  );
}
