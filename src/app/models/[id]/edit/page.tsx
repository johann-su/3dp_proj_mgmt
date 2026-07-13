import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { models } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { ModelForm } from "../../model-form";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditModelPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const session = await getSession();
  if (!session) redirect("/sign-in");

  const [model, categories] = await Promise.all([
    db.query.models.findFirst({
      where: eq(models.id, id),
      with: {
        files: { orderBy: (f, { asc }) => asc(f.position) },
        modelTags: { with: { tag: true } },
        bomItems: { orderBy: (b, { asc }) => asc(b.position) },
      },
    }),
    db.query.categories.findMany({ orderBy: (c, { asc }) => asc(c.name) }),
  ]);
  // Editing is open to any signed-in user (collaborative library); only
  // deletion is owner-gated. See updateModel / deleteModel in ../../actions.ts.
  if (!model) notFound();

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-6">Edit model</h1>
      <ModelForm
        categories={categories}
        userName={session.user.name}
        model={{
          id: model.id,
          title: model.title,
          description: model.description,
          categoryId: model.categoryId,
          tags: model.modelTags.map(({ tag }) => tag.name),
          bom: model.bomItems.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            link: item.link,
            imageUrl: item.imageUrl,
            section: item.section,
          })),
          files: model.files.map((file) => ({
            id: file.id,
            filename: file.filename,
            size: file.size,
            kind: file.kind,
          })),
          createdAt: model.createdAt,
        }}
      />
    </div>
  );
}
