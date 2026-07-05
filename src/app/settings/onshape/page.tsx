import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getOnshapeStatus } from "@/lib/onshape/credentials";
import { OnshapeConnection } from "./onshape-connection";

export const dynamic = "force-dynamic";

export default async function OnshapeSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in");

  const status = await getOnshapeStatus(session.user.id);

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <h1 className="text-2xl font-semibold mb-1">Onshape connection</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Link your Onshape account with an API key to import models from
        cad.onshape.com (documents are exported as <code>.step</code> files),
        keep them in sync when the document changes, and jump back into the
        Onshape editor from a model page.
      </p>
      <OnshapeConnection status={status} />
    </div>
  );
}
