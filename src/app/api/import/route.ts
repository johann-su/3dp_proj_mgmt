import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { stageStream } from "@/lib/storage";
import { fileExtension, IMAGE_EXTENSIONS } from "@/lib/s3";
import { ImportError, IMPORT_USER_AGENT, type ImportedProject } from "@/lib/import/types";
import { importFromMakerworld, parseMakerworldUrl } from "@/lib/import/makerworld";
import { importFromPrintables, parsePrintablesUrl } from "@/lib/import/printables";
import { importFromOnshape } from "@/lib/import/onshape";
import { parseOnshapeUrl } from "@/lib/onshape/api";
import { getBambuCredential } from "@/lib/bambu/credentials";
import { getOnshapeCredential } from "@/lib/onshape/credentials";

export const runtime = "nodejs";
// Downloading large model files from the source platform can take a while.
export const maxDuration = 300;

const MAX_MODEL_BYTES = 1024 * 1024 * 1024; // 1 GB
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".3mf": "model/3mf",
  ".step": "model/step",
  ".stp": "model/step",
};

export type ImportDraft = {
  source: string;
  sourceUrl: string;
  title: string;
  description: string;
  tags: string[];
  files: {
    key: string;
    filename: string;
    size: number;
    contentType: string;
    kind: "model" | "image";
    onshapeElementId?: string;
  }[];
  warnings: string[];
  onshapeMicroversion?: string | null;
};

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { url?: string } | null;
  let url: URL;
  try {
    url = new URL(body?.url ?? "");
  } catch {
    return NextResponse.json({ error: "Enter a valid URL" }, { status: 400 });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return NextResponse.json({ error: "Enter a valid http(s) URL" }, { status: 400 });
  }
  // Drop tracking params (?from=recommend etc.) so the stored source URL and
  // the draft shown in the form are canonical. The importers only use the path.
  url.search = "";

  try {
    let project: ImportedProject;
    if (parseMakerworldUrl(url)) {
      const cred = await getBambuCredential(session.user.id);
      project = await importFromMakerworld(
        url,
        cred ? { token: cred.token, region: cred.region } : {},
      );
    } else {
      const printablesId = parsePrintablesUrl(url);
      const onshapePin = printablesId ? null : parseOnshapeUrl(url);
      if (printablesId) {
        project = await importFromPrintables(url, printablesId);
      } else if (onshapePin) {
        const keys = await getOnshapeCredential(session.user.id);
        project = await importFromOnshape(onshapePin, keys);
      } else {
        return NextResponse.json(
          {
            error:
              "Unsupported URL — paste a MakerWorld (makerworld.com/…/models/…), Printables (printables.com/model/…) or Onshape (cad.onshape.com/documents/…) link",
          },
          { status: 400 },
        );
      }
    }

    const draft: ImportDraft = {
      source: project.source,
      sourceUrl: project.sourceUrl,
      title: project.title,
      description: project.description,
      tags: project.tags,
      files: [],
      warnings: [...project.warnings],
      onshapeMicroversion: project.onshapeMicroversion ?? null,
    };

    for (const asset of project.assets) {
      try {
        const res = await fetch(asset.url, {
          headers: { "User-Agent": IMPORT_USER_AGENT, ...asset.headers },
          redirect: "follow",
        });
        if (!res.ok || !res.body) {
          draft.warnings.push(`Download failed for ${asset.filename} (${res.status})`);
          continue;
        }
        const maxBytes = asset.kind === "model" ? MAX_MODEL_BYTES : MAX_IMAGE_BYTES;
        const contentLength = Number(res.headers.get("content-length") ?? 0);
        if (contentLength > maxBytes) {
          draft.warnings.push(`${asset.filename} is too large, skipped`);
          continue;
        }
        const ext = fileExtension(asset.filename);
        if (asset.kind === "image" && !IMAGE_EXTENSIONS.includes(ext)) {
          continue;
        }
        const contentType =
          CONTENT_TYPES[ext] ??
          res.headers.get("content-type")?.split(";")[0] ??
          "application/octet-stream";
        const staged = await stageStream(asset.filename, res.body, contentType);
        draft.files.push({
          ...staged,
          kind: asset.kind,
          ...(asset.onshapeElementId
            ? { onshapeElementId: asset.onshapeElementId }
            : {}),
        });
      } catch {
        draft.warnings.push(`Download failed for ${asset.filename}`);
      }
    }

    return NextResponse.json(draft);
  } catch (err) {
    if (err instanceof ImportError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error("Import failed", err);
    return NextResponse.json(
      { error: "Import failed — check the URL and try again" },
      { status: 500 },
    );
  }
}
