import Link from "next/link";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { Box } from "lucide-react";
import { db } from "@/db";
import { models } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { fileSrc } from "@/lib/file-token";
import { parametricExtra } from "@/lib/parametric";
import { ModelCard } from "@/components/model-card";

export const dynamic = "force-dynamic";

export default async function MyModelsPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in");

  const results = await db.query.models.findMany({
    where: eq(models.userId, session.user.id),
    orderBy: desc(models.createdAt),
    extras: (m) => ({ parametric: parametricExtra(m.id) }),
    with: {
      user: { columns: { name: true } },
      category: true,
      files: {
        where: (f, { eq }) => eq(f.kind, "image"),
        orderBy: (f, { asc }) => asc(f.position),
        limit: 1,
      },
      modelTags: { with: { tag: true } },
    },
  });

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight mb-1">My Models</h1>
        <p className="text-muted-foreground">
          {results.length} model{results.length === 1 ? "" : "s"} you uploaded.
        </p>
      </div>

      {results.length === 0 ? (
        <div className="text-center py-24 text-muted-foreground">
          <Box className="size-10 mx-auto mb-3 opacity-50" />
          <p>
            You haven&apos;t uploaded any models yet.{" "}
            <Link href="/models/new" className="underline">
              Upload one!
            </Link>
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {results.map((model) => (
            <ModelCard
              key={model.id}
              model={{
                ...model,
                files: model.files.map((f) => ({
                  id: f.id,
                  src: fileSrc(f.id),
                  animated: f.animated,
                })),
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
