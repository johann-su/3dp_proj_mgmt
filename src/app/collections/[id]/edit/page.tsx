import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { collections } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { ruleBuilderFacets } from "@/lib/search";
import { CollectionForm } from "../../collection-form";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditCollectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const [collection, session, facets] = await Promise.all([
    db.query.collections.findFirst({
      where: eq(collections.id, id),
      columns: {
        id: true,
        userId: true,
        title: true,
        description: true,
        sourceUrl: true,
        smart: true,
        rules: true,
      },
    }),
    getSession(),
    ruleBuilderFacets(),
  ]);
  // Editing is open to any signed-in user (collaborative library); only
  // deletion is owner-gated. See updateCollection / deleteCollection.
  if (!collection || !session) notFound();

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-6">Edit collection</h1>
      <CollectionForm
        collectionId={collection.id}
        initialTitle={collection.title}
        initialDescription={collection.description}
        initialSmart={collection.smart}
        initialRules={collection.rules}
        // Imported collections mirror a MakerWorld list; rules would fight sync.
        allowSmart={!collection.sourceUrl}
        facets={facets}
      />
    </div>
  );
}
