import { redirect } from "next/navigation";
import { getSession, signInRedirect } from "@/lib/auth";
import { appUrl } from "@/lib/app-url";
import { listPushTokens } from "@/lib/push-tokens";
import { toPushTokenView } from "./token-view";
import { SlicePushTokens } from "./slice-push-tokens";

export const dynamic = "force-dynamic";

// Set up the OrcaSlicer plugin that pushes a freshly sliced file back to its
// model (issue #122), and revoke the tokens that let it. One token per slicer
// install: the plugin works out *which* model a slice belongs to by itself, so
// nothing here is per-model.
export default async function SlicePushSettingsPage() {
  const session = await getSession();
  if (!session) redirect(await signInRedirect());

  const tokens = await listPushTokens(session.user.id);

  return (
    <div className="max-w-2xl">
      <h1 className="text-lg font-semibold mb-1">Push from slicer</h1>
      <p className="text-sm text-muted-foreground mb-6">
        The Print Vault plugin for OrcaSlicer sends the project you just
        worked on back to the model it came from — settings, filaments and
        colours, where things sit on the plate — as a new revision of that
        model&rsquo;s own .3mf, so the catalogue keeps up with your disk. It
        recognises the model on its own, so you set this up once per machine,
        not once per model. A token grants the same editing access you already
        have, without a login: revoke one here the moment the machine holding it
        is out of your hands.
      </p>
      <SlicePushTokens
        tokens={tokens.map(toPushTokenView)}
        origin={appUrl("/").toString().replace(/\/$/, "")}
      />
    </div>
  );
}
