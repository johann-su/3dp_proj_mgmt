// BlobStore on the local filesystem (e.g. a Docker volume): each key is a file
// under `root`, keys' "/" separators becoming directories.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { randomUUID } from "node:crypto";
import type { BlobBody, BlobStore } from "@/lib/blob-store";
import type { ByteRange } from "@/lib/http-range";

export class FsBlobStore implements BlobStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  // Maps a key to its file, refusing anything that could land outside the
  // root. Keys are generated server-side, but they round-trip through the DB
  // and version snapshots, so a traversal attempt must fail here regardless.
  private pathFor(key: string): string {
    const segments = key.split("/");
    if (
      key.includes("\\") ||
      key.includes("\0") ||
      segments.some((s) => s === "" || s === "." || s === "..")
    ) {
      throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
    }
    const resolved = path.resolve(this.root, ...segments);
    if (!resolved.startsWith(this.root + path.sep)) {
      throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
    }
    return resolved;
  }

  // No content type is kept: the file routes derive it from the filename's
  // allowlisted extension, never from what was stored (see files.md).
  async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(path.dirname(target), { recursive: true });
    // Write beside the target and rename into place: rename is atomic within
    // a filesystem, so a reader never sees a half-written file and a failed
    // upload leaves nothing behind under the key.
    const temp = `${target}.${randomUUID()}.partial`;
    try {
      if (body instanceof Uint8Array) {
        await writeFile(temp, body);
      } else {
        await pipeline(
          Readable.fromWeb(body as unknown as NodeReadableStream),
          createWriteStream(temp),
        );
      }
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }

  async get(key: string, range?: ByteRange): Promise<BlobBody | null> {
    const file = this.pathFor(key);
    let size: number;
    try {
      const info = await stat(file);
      if (!info.isFile()) return null;
      size = info.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }

    const start = range?.start ?? 0;
    const end = Math.min(range?.end ?? size - 1, size - 1);
    if (end < start) {
      return { stream: new Blob([]).stream(), contentLength: 0 };
    }
    const stream = Readable.toWeb(
      createReadStream(file, { start, end }),
    ) as unknown as ReadableStream<Uint8Array>;
    return { stream, contentLength: end - start + 1 };
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) {
      const file = this.pathFor(key);
      await rm(file, { force: true });
      // Upload keys are "uploads/<uuid>/<name>", one directory per file, so
      // prune directories the delete emptied rather than accumulating them.
      // rmdir only removes empty ones; the first non-empty parent stops it.
      let dir = path.dirname(file);
      while (dir !== this.root && dir.startsWith(this.root + path.sep)) {
        try {
          await rmdir(dir);
        } catch {
          break;
        }
        dir = path.dirname(dir);
      }
    }
  }
}
