// Shared validation for the customize endpoints (generate + preview): checks
// the viewer is signed in, locates the .scad file, fetches its source from storage
// and coerces the submitted customizer values against the parsed schema.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { modelFiles, models } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { fileExtension } from "@/lib/file-kind";
import { readBlobBytes } from "@/lib/blob-store";
import { blobStore } from "@/lib/storage";
import { MAX_SCAD_SOURCE_BYTES } from "@/lib/openscad";
import {
  coerceScadValues,
  findForbiddenFileRefs,
  parseScadParameters,
} from "@/lib/scad-params";

type FileRow = typeof modelFiles.$inferSelect;
type ModelWithFiles = typeof models.$inferSelect & { files: FileRow[] };

export type ScadRenderRequest = {
  model: ModelWithFiles;
  source: FileRow;
  scadSource: string;
  values: Record<string, string>;
  // The signed-in user driving the render — stored as the variant's generator
  // so a non-owner can later delete the variants they created.
  userId: string;
};

export async function prepareScadRender(
  modelId: string,
  body: unknown,
): Promise<{ error: string; status: number } | ScadRenderRequest> {
  const session = await getSession();
  if (!session) return { error: "Unauthorized", status: 401 };

  const model = (await db.query.models.findFirst({
    where: eq(models.id, modelId),
    with: { files: true },
  })) as ModelWithFiles | undefined;
  if (!model || model.deletedAt) return { error: "Model not found", status: 404 };
  // Customizing (preview + generating a stored variant) is open to any
  // signed-in user, not just the owner — generated variants land on the
  // owner's model like a shared render. Deleting variants stays owner-only.

  const parsed = body as { fileId?: string; values?: Record<string, unknown> } | null;
  if (!parsed?.fileId || typeof parsed.values !== "object" || parsed.values === null) {
    return { error: "Invalid request", status: 400 };
  }

  const source = model.files.find(
    (f) =>
      f.id === parsed.fileId &&
      f.kind === "model" &&
      fileExtension(f.filename) === ".scad",
  );
  if (!source) {
    return { error: "Not a .scad file of this model", status: 400 };
  }
  if (source.size > MAX_SCAD_SOURCE_BYTES) {
    return { error: "Source file too large", status: 422 };
  }

  const bytes = await readBlobBytes(blobStore(), source.s3Key);
  if (!bytes) {
    return { error: "Source file unavailable", status: 502 };
  }
  const scadSource = Buffer.from(bytes).toString("utf8");

  const violations = findForbiddenFileRefs(scadSource);
  if (violations.length > 0) {
    return {
      error:
        "This .scad file references external files, which is not supported: " +
        violations.join("; "),
      status: 422,
    };
  }

  const groups = parseScadParameters(scadSource);
  if (groups.length === 0) {
    return { error: "No customizer parameters found in this file", status: 400 };
  }

  return {
    model,
    source,
    scadSource,
    values: coerceScadValues(groups, parsed.values),
    userId: session.user.id,
  };
}
