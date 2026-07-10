import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { collections } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { EditCollectionForm } from "./edit-collection-form";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditCollectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const [collection, session] = await Promise.all([
    db.query.collections.findFirst({
      where: eq(collections.id, id),
      columns: { id: true, userId: true, title: true, description: true },
    }),
    getSession(),
  ]);
  if (!collection || session?.user.id !== collection.userId) notFound();

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-6">Edit collection</h1>
      <EditCollectionForm
        collectionId={collection.id}
        initialTitle={collection.title}
        initialDescription={collection.description}
      />
    </div>
  );
}
