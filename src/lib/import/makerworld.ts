// MakerWorld importer — best effort. MakerWorld sits behind Cloudflare bot
// protection and file downloads require a signed-in Bambu account, so this
// imports metadata + images from the page's __NEXT_DATA__ JSON when the page
// is reachable, and fails with a clear message when Cloudflare blocks us.
// (Fallback that always works: download the .3mf in a browser and upload it —
// the .3mf metadata extractor prefills everything.)

import { htmlishToText } from "@/lib/html";
import { ImportError, IMPORT_USER_AGENT, type ImportedProject } from "./types";

const MAX_IMAGES = 8;

export function parseMakerworldUrl(url: URL): string | null {
  if (!/(^|\.)makerworld\.com$/.test(url.hostname)) return null;
  const match = url.pathname.match(/\/models\/(\d+)/);
  return match ? match[1] : null;
}

type MakerworldDesign = {
  title?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  designExtension?: { design_pictures?: { url?: string; name?: string }[] };
  design_pictures?: { url?: string; name?: string }[];
  cover?: string;
};

function findDesign(node: unknown, depth = 0): MakerworldDesign | null {
  if (!node || typeof node !== "object" || depth > 6) return null;
  const obj = node as Record<string, unknown>;
  if (typeof obj.title === "string" && ("designExtension" in obj || "design_pictures" in obj || "cover" in obj)) {
    return obj as MakerworldDesign;
  }
  for (const value of Object.values(obj)) {
    const found = findDesign(value, depth + 1);
    if (found) return found;
  }
  return null;
}

export async function importFromMakerworld(url: URL): Promise<ImportedProject> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": IMPORT_USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  const html = await res.text();

  if (!res.ok || html.includes("Just a moment") || html.includes("cf-chl")) {
    throw new ImportError(
      "MakerWorld blocked the request (Cloudflare bot protection). " +
        "Download the .3mf in your browser instead and upload it — its metadata is imported automatically.",
    );
  }

  const nextData = html.match(
    /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!nextData) {
    throw new ImportError("Could not find model data on the MakerWorld page");
  }

  let design: MakerworldDesign | null = null;
  try {
    const parsed = JSON.parse(nextData[1]) as { props?: unknown };
    design = findDesign(parsed.props);
  } catch {
    // fall through to the error below
  }
  if (!design?.title) {
    throw new ImportError("Could not extract model info from the MakerWorld page");
  }

  const pictures =
    design.designExtension?.design_pictures ?? design.design_pictures ?? [];
  const images = pictures
    .map((p) => p.url)
    .filter((u): u is string => typeof u === "string" && u.startsWith("http"))
    .slice(0, MAX_IMAGES);
  if (images.length === 0 && design.cover?.startsWith("http")) {
    images.push(design.cover);
  }

  return {
    source: "makerworld",
    sourceUrl: url.toString(),
    title: design.title.trim(),
    description: htmlishToText(design.description ?? design.summary ?? ""),
    tags: (design.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
    assets: images.map((imageUrl, i) => ({
      url: imageUrl,
      filename: imageUrl.split("/").pop()?.split("?")[0] || `image-${i + 1}.jpg`,
      kind: "image" as const,
    })),
    warnings: [
      "MakerWorld does not allow anonymous file downloads — metadata and images were imported; add the .3mf manually.",
    ],
  };
}
