import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { user } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isAdmin } from "@/lib/roles";
import { formatDate } from "@/lib/format";
import { UsersTable } from "./users-table";

export const dynamic = "force-dynamic";

// Admin-only user management (issue #54): everyone with an account on this
// instance, with a control to change their role. The settings layout already
// ran the ensureInitialAdmin bootstrap before this page renders.
export default async function UsersSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  if (!isAdmin(session.user.role)) redirect("/settings");

  const users = await db.query.user.findMany({
    orderBy: asc(user.createdAt),
    columns: { id: true, name: true, email: true, role: true, createdAt: true },
  });

  return (
    <section>
      <h2 className="text-lg font-semibold mb-1">Users</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Everyone with an account on this instance. Moderators can delete any
        model or collection and see the whole trash; admins can additionally
        manage users here.
      </p>
      <UsersTable
        users={users.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          signedUp: formatDate(u.createdAt),
        }))}
        currentUserId={session.user.id}
      />
    </section>
  );
}
