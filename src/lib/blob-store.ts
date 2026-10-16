// File storage backend: where uploaded model files, images, PDFs and videos
// physically live. Everything above this layer (staging, the file routes,
// slicing, export, versioning's deletes) talks to a BlobStore by key and never
// to a specific backend, so S3 and the local filesystem are interchangeable.
//
// Keys are the opaque relative paths stored in model_files.s3_key (the column
// predates the abstraction — it holds a key for whichever backend is
// configured), e.g. "uploads/<uuid>/<sanitized-name>". They are written once
// and never renamed: version snapshots reference them, see versioning.md.
//
// One backend per instance, chosen by STORAGE_BACKEND (see
// resolveStorageConfig). Switching an existing instance means copying every
// object to the new backend under the same key.

import type { ByteRange } from "@/lib/http-range";

export type BlobBody = {
  stream: ReadableStream<Uint8Array>;
  // Bytes in `stream` — the range's length for a ranged read. Undefined only
  // when the backend didn't report it; callers then omit Content-Length.
  contentLength?: number;
};

export interface BlobStore {
  // Stores the bytes under `key`, replacing anything already there. A failed
  // or aborted write must not leave a partial object readable under `key`.
  put(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    contentType: string,
  ): Promise<void>;
  // The object's bytes (or the inclusive `range` of them), or null when no
  // object exists under `key`. Other failures (backend down, permissions)
  // throw. A range past the end of the object yields an empty body.
  get(key: string, range?: ByteRange): Promise<BlobBody | null>;
  // Deletes every key; keys that don't exist are not an error.
  delete(keys: string[]): Promise<void>;
}

export type StorageConfig =
  | {
      backend: "s3";
      endpoint?: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    }
  | { backend: "filesystem"; root: string };

// Reads the storage settings from the environment. STORAGE_BACKEND defaults to
// "s3" so instances configured before the filesystem backend existed keep
// working unchanged. Throws on a misconfiguration rather than silently falling
// back — storing uploads somewhere unexpected would lose them on redeploy.
export function resolveStorageConfig(
  env: Record<string, string | undefined> = process.env,
): StorageConfig {
  const backend = (env.STORAGE_BACKEND ?? "").trim().toLowerCase() || "s3";
  if (backend === "s3") {
    if (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
      throw new Error(
        "S3 storage requires S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY " +
          "(or set STORAGE_BACKEND=filesystem)",
      );
    }
    return {
      backend: "s3",
      endpoint: env.S3_ENDPOINT || undefined,
      region: env.S3_REGION ?? "us-east-1",
      bucket: env.S3_BUCKET ?? "models",
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    };
  }
  if (backend === "filesystem") {
    const root = env.STORAGE_PATH?.trim();
    if (!root) {
      throw new Error("STORAGE_BACKEND=filesystem requires STORAGE_PATH");
    }
    return { backend: "filesystem", root };
  }
  throw new Error(
    `Unknown STORAGE_BACKEND "${env.STORAGE_BACKEND}" (expected "s3" or "filesystem")`,
  );
}

// Reads a whole object (or a range of it) into memory; null when missing.
export async function readBlobBytes(
  store: BlobStore,
  key: string,
  range?: ByteRange,
): Promise<Uint8Array | null> {
  const blob = await store.get(key, range);
  if (!blob) return null;
  return new Uint8Array(await new Response(blob.stream).arrayBuffer());
}
