import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { Upload } from "@aws-sdk/lib-storage";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { s3, S3_BUCKET } from "@/lib/s3";
import { isAnimatedImage } from "@/lib/image-animated";

export type StagedFile = {
  key: string;
  filename: string;
  size: number;
  contentType: string;
};

// Streams a file into the staging area of the bucket ("uploads/…") and
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
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: S3_BUCKET,
      Key: key,
      Body: Buffer.from(data),
      ContentType: contentType,
    },
  });
  await upload.done();
  return { key, filename, size: data.byteLength, contentType };
}

export async function stageStream(
  filename: string,
  body: ReadableStream<Uint8Array>,
  contentType: string,
): Promise<StagedFile> {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `uploads/${randomUUID()}/${safeName}`;

  let size = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: S3_BUCKET,
      Key: key,
      Body: Readable.fromWeb(
        body.pipeThrough(counter) as unknown as import("node:stream/web").ReadableStream,
      ),
      ContentType: contentType,
    },
  });
  await upload.done();

  return { key, filename, size, contentType };
}

// Reads a small text file (e.g. a parametric .scad source) from S3. Returns
// null when the object is missing or larger than maxBytes — callers treat
// that as "no parseable content", never as an error.
export async function readTextFile(
  s3Key: string,
  size: number,
  maxBytes: number,
): Promise<string | null> {
  if (size > maxBytes) return null;
  try {
    const object = await s3.send(
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }),
    );
    if (!object.Body) return null;
    return Buffer.from(await object.Body.transformToByteArray()).toString("utf8");
  } catch {
    return null;
  }
}

// Reads a staged image's header from S3 and reports whether it's animated, so
// browse cards can freeze animated covers to a poster frame (see CoverImage).
// Detected server-side from the actual bytes — like contentTypeForFilename, we
// never trust a client-claimed value. Best-effort: a read failure means "not
// animated" (worst case a card animates, matching the old behaviour).
export async function detectAnimated(s3Key: string): Promise<boolean> {
  try {
    const object = await s3.send(
      new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Range: "bytes=0-255",
      }),
    );
    if (!object.Body) return false;
    return isAnimatedImage(await object.Body.transformToByteArray());
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
