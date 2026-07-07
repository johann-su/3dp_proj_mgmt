import Link from "next/link";
import { redirect } from "next/navigation";
import { FolderOpen } from "lucide-react";
import { getSession } from "@/lib/auth";
import { listUserCollections } from "@/lib/list-queries";
import { CollectionGrid } from "@/components/collection-grid";

export const dynamic = "force-dynamic";

export default async function MyCollectionsPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in");

  const { items: results, nextCursor } = await listUserCollections({
    userId: session.user.id,
  });

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight mb-1">My Collections</h1>
        <p className="text-muted-foreground">
          {results.length}
          {nextCursor ? "+" : ""} collection{results.length === 1 ? "" : "s"}.
        </p>
      </div>

      {results.length === 0 ? (
        <div className="text-center py-24 text-muted-foreground">
          <FolderOpen className="size-10 mx-auto mb-3 opacity-50" />
          <p>
            No collections yet.{" "}
            <Link href="/collections/new" className="underline">
              Create one!
            </Link>
          </p>
        </div>
      ) : (
        <CollectionGrid
          key={results.map((c) => c.id).join(",")}
          initialItems={results}
          initialCursor={nextCursor}
        />
      )}
    </div>
  );
}
