import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { SettingsNav } from "./settings-nav";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/sign-in");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-6">Settings</h1>
      <div className="grid gap-8 sm:grid-cols-[12rem_1fr]">
        <aside className="sm:sticky sm:top-20 sm:self-start">
          <SettingsNav />
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
