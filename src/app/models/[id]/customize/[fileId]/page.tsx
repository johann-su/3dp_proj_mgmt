import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { models } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { fileExtension } from "@/lib/file-kind";
import { readTextFile } from "@/lib/storage";
import { MAX_SCAD_SOURCE_BYTES, openscadConfigured } from "@/lib/openscad";
import { parseScadParameters } from "@/lib/scad-params";
import { CustomizeView } from "./customize-view";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Full-page customizer for a parametric .scad model file: parameter rail on
// the left, live 3D preview (rendered by the openscad service) on the right.
// Owner-only, like generating variants — everyone else is sent back to the
// model page.
export default async function CustomizePage({
  params,
}: {
  params: Promise<{ id: string; fileId: string }>;
}) {
  const { id, fileId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(fileId)) notFound();

  const [model, session] = await Promise.all([
    db.query.models.findFirst({
      where: eq(models.id, id),
      with: { files: true },
    }),
    getSession(),
  ]);
  if (!session) redirect("/sign-in");
  if (!model) notFound();
  if (model.userId !== session.user.id || !openscadConfigured()) {
    redirect(`/models/${id}`);
  }

  const file = model.files.find(
    (f) =>
      f.id === fileId &&
      f.kind === "model" &&
      fileExtension(f.filename) === ".scad",
  );
  if (!file) notFound();

  const source = await readTextFile(file.s3Key, file.size, MAX_SCAD_SOURCE_BYTES);
  const groups = source ? parseScadParameters(source) : [];
  if (groups.length === 0) redirect(`/models/${id}`);

  return (
    <CustomizeView
      modelId={model.id}
      modelTitle={model.title}
      fileId={file.id}
      filename={file.filename}
      groups={groups}
    />
  );
}
