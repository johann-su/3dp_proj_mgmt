import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { user } from "@/db/schema";
import { initialAdminEmail } from "@/lib/auth";

// Lazy half of the first-admin bootstrap (the eager half is the user-create
// hook in src/lib/auth.ts): while the database has no admin at all, promote
// the INITIAL_ADMIN_EMAIL account on the next settings page load — the same
// no-scheduler pattern as the trash sweep and the import-job heartbeat. Once
// any admin exists the env var is inert (roles are managed on
// Settings → Users), but it recovers an instance whose last admin is gone.
export async function ensureInitialAdmin(): Promise<void> {
  if (!initialAdminEmail) return;
  const admin = await db.query.user.findFirst({
    where: eq(user.role, "admin"),
    columns: { id: true },
  });
  if (admin) return;
  await db
    .update(user)
    .set({ role: "admin", updatedAt: new Date() })
    .where(sql`lower(${user.email}) = ${initialAdminEmail}`);
}
