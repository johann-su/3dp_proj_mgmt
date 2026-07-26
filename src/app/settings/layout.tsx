import { redirect } from "next/navigation";
import { getSession, mcpEnabled, signInRedirect } from "@/lib/auth";
import { ensureInitialAdmin } from "@/lib/admin";
import { isAdmin } from "@/lib/roles";
import { SettingsNav } from "./settings-nav";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // First-admin bootstrap: while no admin exists, promote the
  // INITIAL_ADMIN_EMAIL account. Runs before getSession so the fresh role is
  // already on the session and the Users nav entry shows on this very load.
  await ensureInitialAdmin();

  const session = await getSession();
  if (!session) redirect(await signInRedirect());

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-6">Settings</h1>
      <div className="grid gap-8 sm:grid-cols-[12rem_1fr]">
        <aside className="sm:sticky sm:top-20 sm:self-start">
          <SettingsNav
            showMcp={mcpEnabled}
            showUsers={isAdmin(session.user.role)}
          />
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
