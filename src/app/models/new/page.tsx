import { redirect } from "next/navigation";
import { db } from "@/db";
import { getSession } from "@/lib/auth";
import { ModelForm } from "../model-form";

export const dynamic = "force-dynamic";

export default async function NewModelPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in");

  const categories = await db.query.categories.findMany({
    orderBy: (c, { asc }) => asc(c.name),
  });

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-6">New model</h1>
      <ModelForm categories={categories} userName={session.user.name} />
    </div>
  );
}
