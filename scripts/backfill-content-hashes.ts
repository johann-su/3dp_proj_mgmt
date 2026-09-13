// Backfills model_files.content_hash for rows that predate it.
//
// The column is written while streaming to S3 on upload (src/lib/storage.ts),
// so anything uploaded before issue #118 has none. Two features depend on it:
// duplicate detection, and slice-push's "which model is this file?" resolve
// (issue #122) — which silently matches nothing for a catalogue full of null
// hashes, because a null hash simply never matches.
//
// Streams each object from S3 and hashes it without ever holding a whole file
// in memory (a .3mf is small, but a pushed G-code is not). Safe to re-run: it
// only ever looks at rows where content_hash IS NULL, and it only writes that
// one column.
//
//   node --env-file=.env --import tsx scripts/backfill-content-hashes.ts [--dry-run]

import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { db } from "@/db";
import { modelFiles } from "@/db/schema";
import { s3, S3_BUCKET } from "@/lib/s3";

const dryRun = process.argv.includes("--dry-run");

async function hashObject(key: string): Promise<string> {
  const object = await s3.send(
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
  );
  const body = object.Body as NodeJS.ReadableStream | undefined;
  if (!body) throw new Error("empty body");
  const digest = createHash("sha256");
  for await (const chunk of body) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

async function main() {
  // Only `kind: "model"` rows carry a hash: images and PDFs are legitimately
  // shared between models, and generated OpenSCAD variants are identified by
  // their parameter hash instead.
  const rows = await db
    .select({ id: modelFiles.id, s3Key: modelFiles.s3Key, filename: modelFiles.filename })
    .from(modelFiles)
    .where(
      and(
        isNull(modelFiles.contentHash),
        eq(modelFiles.kind, "model"),
        isNull(modelFiles.generatedFromId),
      ),
    );

  console.log(`${rows.length} file(s) without a content hash${dryRun ? " (dry run)" : ""}`);
  let done = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const hash = await hashObject(row.s3Key);
      if (!dryRun) {
        await db
          .update(modelFiles)
          .set({ contentHash: hash })
          .where(eq(modelFiles.id, row.id));
      }
      done += 1;
      console.log(`  ${hash.slice(0, 12)}…  ${row.filename}`);
    } catch (err) {
      // A missing object is not worth aborting a catalogue-wide backfill for:
      // report it and keep going, since every other row is still fixable.
      failed += 1;
      console.error(`  FAILED ${row.filename} (${row.s3Key}): ${(err as Error).message}`);
    }
  }
  console.log(`hashed ${done}, failed ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
