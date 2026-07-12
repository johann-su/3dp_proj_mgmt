// Extracts the OpenSCAD sources from MakerWorld's raw-model download.
//
// That download (GET …/design/{id}/model?modelType=all) is a single zip of
// *every* raw file the maker uploaded — for a parametric model that means the
// tiny .scad sources sit alongside hundreds of megabytes of geometry (e.g. the
// Gridfinity bins model bundles ~450 MB of "raw 3mf export" zips next to a
// 22 KB .scad). We only want the .scad, so we stream the archive through
// fflate's incremental Unzip and only ever decompress the .scad entries —
// geometry entries are skipped without being read into memory. Kept pure (no
// S3/network) so it can be unit-tested with an in-memory zip fixture.

import { Unzip, UnzipInflate } from "fflate";
import { fileExtension } from "@/lib/file-kind";

export type ExtractedScad = { name: string; bytes: Uint8Array };

function concat(parts: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function isScadEntry(name: string): boolean {
  return fileExtension(name) === ".scad" && !name.startsWith("__MACOSX");
}

// Streams `stream`, returning every .scad it contains. If the download is a
// bare .scad file rather than a zip, it is returned under `fallbackName`.
// Any single entry larger than `maxFileBytes` is dropped (a .scad source is
// text — a huge one is not what we're after and shouldn't be buffered).
export async function extractScadFiles(
  stream: ReadableStream<Uint8Array>,
  opts: { fallbackName: string; maxFileBytes: number },
): Promise<ExtractedScad[]> {
  const reader = stream.getReader();
  const first = await reader.read();
  const head = first.value ?? new Uint8Array();
  const isZip = head[0] === 0x50 && head[1] === 0x4b; // "PK"

  if (!isZip) {
    // A single raw file served directly — keep it only if it's a .scad.
    if (!isScadEntry(opts.fallbackName)) {
      await reader.cancel();
      return [];
    }
    const parts: Uint8Array[] = [];
    let size = 0;
    if (head.byteLength) {
      parts.push(head);
      size += head.byteLength;
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > opts.maxFileBytes) {
        await reader.cancel();
        return [];
      }
      parts.push(value);
    }
    return [{ name: opts.fallbackName, bytes: concat(parts, size) }];
  }

  type Pending = { name: string; parts: Uint8Array[]; size: number; dropped: boolean };
  const pending: Pending[] = [];
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    if (!isScadEntry(file.name)) return; // not started → data is skipped, never decompressed
    const entry: Pending = {
      name: file.name.split("/").pop() || file.name,
      parts: [],
      size: 0,
      dropped: false,
    };
    pending.push(entry);
    file.ondata = (err, chunk) => {
      if (err || entry.dropped) return;
      entry.size += chunk.byteLength;
      if (entry.size > opts.maxFileBytes) {
        entry.dropped = true;
        entry.parts = [];
        return;
      }
      entry.parts.push(chunk);
    };
    file.start();
  };

  unzip.push(head, false);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      unzip.push(new Uint8Array(), true);
      break;
    }
    unzip.push(value, false);
  }

  return pending
    .filter((e) => !e.dropped && e.size > 0)
    .map((e) => ({ name: e.name, bytes: concat(e.parts, e.size) }));
}
