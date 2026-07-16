import { redirect } from "next/navigation";
import { asc, count } from "drizzle-orm";
import { db } from "@/db";
import { models, user } from "@/db/schema";
import { getSession, signInRedirect } from "@/lib/auth";
import { isAdmin } from "@/lib/roles";
import { formatDate } from "@/lib/format";
import { UsersTable } from "./users-table";

export const dynamic = "force-dynamic";

// Admin-only user management (issue #54): everyone with an account on this
// instance, with a control to change their role. The settings layout already
// ran the ensureInitialAdmin bootstrap before this page renders.
export default async function UsersSettingsPage() {
  const session = await getSession();
  if (!session) redirect(await signInRedirect());
  if (!isAdmin(session.user.role)) redirect("/settings");

  const users = await db.query.user.findMany({
    orderBy: asc(user.createdAt),
    columns: { id: true, name: true, email: true, role: true, createdAt: true },
  });

  // Owned models per user, trashed included — deleting an account purges all
  // of them permanently, so the delete dialog warns with this number.
  const modelCounts = new Map(
    (
      await db
        .select({ userId: models.userId, count: count() })
        .from(models)
        .groupBy(models.userId)
    ).map((row) => [row.userId, row.count]),
  );

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
          modelCount: modelCounts.get(u.id) ?? 0,
        }))}
        currentUserId={session.user.id}
      />
    </section>
  );
}
