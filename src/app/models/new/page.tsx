import { redirect } from "next/navigation";
import { db } from "@/db";
import { getSession } from "@/lib/auth";
import { NewModelForm } from "./new-model-form";

export const dynamic = "force-dynamic";

export default async function NewModelPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in");

  const categories = await db.query.categories.findMany({
    orderBy: (c, { asc }) => asc(c.name),
  });

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-6">New model</h1>
      <NewModelForm categories={categories} />
    </div>
  );
}
