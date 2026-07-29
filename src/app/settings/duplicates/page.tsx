import { redirect } from "next/navigation";
import { getSession, signInRedirect } from "@/lib/auth";
import { isModerator } from "@/lib/roles";
import { listOpenDuplicates } from "@/lib/duplicates";
import { DuplicatesList } from "./duplicates-list";

export const dynamic = "force-dynamic";

// Moderator/admin-only duplicate worklist (issue #118). Detection at import
// and upload time only *flags* — every signed-in user can wave a flag away and
// add the copy anyway — so this page is where those dismissed matches pile up
// for someone to actually resolve.
export default async function DuplicatesSettingsPage() {
  const session = await getSession();
  if (!session) redirect(await signInRedirect());
  if (!isModerator(session.user.role)) redirect("/settings");

  const duplicates = await listOpenDuplicates();

  return (
    <section>
      <h2 className="text-lg font-semibold mb-1">Duplicates</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Models that were flagged as copies of something already in the library
        and added anyway. Nothing here has been changed — trashing a copy puts
        it in the trash, where its owner can still restore it.
      </p>
      <DuplicatesList duplicates={duplicates} />
    </section>
  );
}
