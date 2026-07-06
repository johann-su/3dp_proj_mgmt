import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { Upload } from "@aws-sdk/lib-storage";
import { s3, S3_BUCKET } from "@/lib/s3";

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
