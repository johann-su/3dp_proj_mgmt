import { redirect } from "next/navigation";
import { getSession, signInRedirect } from "@/lib/auth";
import { getBambuStatus } from "@/lib/bambu/credentials";
import { BambuConnection } from "./bambu-connection";

export const dynamic = "force-dynamic";

export default async function BambuSettingsPage() {
  const session = await getSession();
  if (!session) redirect(await signInRedirect());

  const status = await getBambuStatus(session.user.id);

  return (
    <div className="max-w-lg">
      <h1 className="text-lg font-semibold mb-1">Bambu Cloud connection</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Link your Bambu Lab account to download <code>.3mf</code> files when
        importing from MakerWorld. MakerWorld requires a signed-in Bambu account
        for downloads; metadata and images import without it.
      </p>
      <BambuConnection status={status} />
    </div>
  );
}
