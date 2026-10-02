// BlobStore on any S3-compatible object storage (AWS S3, MinIO, Garage, …).

import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { BlobBody, BlobStore, StorageConfig } from "@/lib/blob-store";
import { toS3Range, type ByteRange } from "@/lib/http-range";

type S3Config = Extract<StorageConfig, { backend: "s3" }>;

export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // Non-AWS servers (Garage) return bogus x-amz-checksum-* headers that
      // trip the SDK's default flexible-checksum validation.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  async put(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    contentType: string,
  ): Promise<void> {
    // lib-storage's Upload does multipart for large/unknown-length streams.
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body:
          body instanceof Uint8Array
            ? Buffer.from(body)
            : Readable.fromWeb(body as unknown as NodeReadableStream),
        ContentType: contentType,
      },
    });
    await upload.done();
  }

  async get(key: string, range?: ByteRange): Promise<BlobBody | null> {
    try {
      const object = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(range ? { Range: toS3Range(range) } : {}),
        }),
      );
      if (!object.Body) return null;
      return {
        stream: object.Body.transformToWebStream() as ReadableStream<Uint8Array>,
        contentLength: object.ContentLength,
      };
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === "NoSuchKey" || name === "NotFound") return null;
      // S3 rejects a range starting past the end; the contract is an empty body.
      if (name === "InvalidRange") {
        return { stream: new Blob([]).stream(), contentLength: 0 };
      }
      throw err;
    }
  }

  async delete(keys: string[]): Promise<void> {
    // DeleteObjects takes at most 1000 keys per call.
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })) },
        }),
      );
    }
  }
}
