import { createHash, randomUUID } from "node:crypto";
import {
  readBlobBytes,
  resolveStorageConfig,
  type BlobStore,
} from "@/lib/blob-store";
import { FsBlobStore } from "@/lib/blob-store-fs";
import { S3BlobStore } from "@/lib/blob-store-s3";
import { isAnimatedImage } from "@/lib/image-animated";
import { reportError } from "@/lib/telemetry";

let store: BlobStore | undefined;

// The configured storage backend (see resolveStorageConfig), built on first
// use rather than at import so that merely importing this module has no side
// effects and a misconfiguration surfaces as an error where files are touched.
export function blobStore(): BlobStore {
  if (!store) {
    const config = resolveStorageConfig();
    store =
      config.backend === "filesystem"
        ? new FsBlobStore(config.root)
        : new S3BlobStore(config);
  }
  return store;
}

export type StagedFile = {
  key: string;
  filename: string;
  size: number;
  contentType: string;
  // Lowercase hex SHA-256 of the bytes, digested as they stream past on their
  // way to storage rather than by reading the object back. Stored on model files
  // (model_files.content_hash) to flag re-uploads of the same file as
  // duplicates — see @/lib/duplicates.
  contentHash: string;
};

// Streams a file into the staging area of storage ("uploads/…") and
// returns the descriptor used by createModel. Size is counted while
// streaming so it works without a Content-Length.
// Stages an in-memory file the same way; used when the bytes had to be
// buffered anyway (e.g. Onshape 3MF exports that get normalized first).
export async function stageBuffer(
  filename: string,
  data: Uint8Array,
  contentType: string,
): Promise<StagedFile> {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `uploads/${randomUUID()}/${safeName}`;
  await blobStore().put(key, data, contentType);
  return {
    key,
    filename,
    size: data.byteLength,
    contentType,
    contentHash: createHash("sha256").update(data).digest("hex"),
  };
}

export async function stageStream(
  filename: string,
  body: ReadableStream<Uint8Array>,
  contentType: string,
): Promise<StagedFile> {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `uploads/${randomUUID()}/${safeName}`;

  // Size and content hash are both derived from the bytes as they pass
  // through, so the object never has to be read back to learn either.
  let size = 0;
  const digest = createHash("sha256");
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      digest.update(chunk);
      controller.enqueue(chunk);
    },
  });

  await blobStore().put(key, body.pipeThrough(counter), contentType);

  return { key, filename, size, contentType, contentHash: digest.digest("hex") };
}

// Reads a small text file (e.g. a parametric .scad source) from storage. Returns
// null when the object is missing or larger than maxBytes — callers treat
// that as "no parseable content", never as an error.
export async function readTextFile(
  s3Key: string,
  size: number,
  maxBytes: number,
): Promise<string | null> {
  if (size > maxBytes) return null;
  try {
    const bytes = await readBlobBytes(blobStore(), s3Key);
    return bytes && Buffer.from(bytes).toString("utf8");
  } catch {
    return null;
  }
}

// Reads a stored object in full (the export zip needs the bytes in memory to
// hand them to zipSync). Returns null when the object is missing or
// unreadable, so an export skips that one file instead of failing the whole
// download — a model whose stored object vanished should still export the rest.
export async function readFileBytes(s3Key: string): Promise<Uint8Array | null> {
  try {
    const bytes = await readBlobBytes(blobStore(), s3Key);
    if (!bytes) reportError(`Stored file ${s3Key} is missing`, new Error("not found"));
    return bytes;
  } catch (err) {
    reportError(`Failed to read ${s3Key} from storage`, err);
    return null;
  }
}

// Reads a staged image's header from storage and reports whether it's animated, so
// browse cards can freeze animated covers to a poster frame (see CoverImage).
// Detected server-side from the actual bytes — like contentTypeForFilename, we
// never trust a client-claimed value. Best-effort: a read failure means "not
// animated" (worst case a card animates, matching the old behaviour).
export async function detectAnimated(s3Key: string): Promise<boolean> {
  try {
    const header = await readBlobBytes(blobStore(), s3Key, { start: 0, end: 255 });
    return !!header && isAnimatedImage(header);
  } catch {
    return false;
  }
}

// Returns the set of keys (from the given files) that are animated images.
// Non-image files are skipped; the header reads run concurrently.
export async function animatedImageKeys(
  files: { key: string; kind: string }[],
): Promise<Set<string>> {
  const images = files.filter((f) => f.kind === "image");
  const flags = await Promise.all(
    images.map(async (f) => [f.key, await detectAnimated(f.key)] as const),
  );
  return new Set(flags.filter(([, animated]) => animated).map(([key]) => key));
}
