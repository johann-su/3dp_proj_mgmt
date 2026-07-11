import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { ruleBuilderFacets } from "@/lib/search";
import { CollectionForm } from "../collection-form";

export default async function NewCollectionPage() {
  // The whole catalog is private — self-hosted instances store paid models.
  const session = await getSession();
  if (!session) redirect("/sign-in");

  const facets = await ruleBuilderFacets();

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-6">New collection</h1>
      <CollectionForm allowSmart facets={facets} />
    </div>
  );
}
