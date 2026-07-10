// MakerWorld importer — reads metadata + images from the public Bambu design
// API (api.bambulab.com), which returns JSON anonymously and is NOT behind the
// Cloudflare bot wall that guards makerworld.com HTML pages.
//
// File downloads require an authenticated Bambu Cloud account. When the user
// has connected one (Settings → Bambu Cloud), each print profile is exchanged
// for a short-lived presigned URL and imported as a .3mf; otherwise only
// metadata + images are imported and the user adds the .3mf manually.

import { htmlishToMarkdown } from "@/lib/html";
import {
  apiBase,
  fetchProfileDownload,
  type BambuRegion,
} from "@/lib/bambu/cloud";
import { ImportError, IMPORT_USER_AGENT, type ImportedProject, type RemoteAsset } from "./types";

const MAX_IMAGES = 8;
const MAX_FILES = 8;

// Exact warning pushed when the stored Bambu token stops working. The
// collection import job matches on it to abort early (every following
// download would fail the same way) — keep the two in sync via this constant.
export const BAMBU_EXPIRED_WARNING =
  "Your Bambu Cloud login has expired — reconnect it in Settings → Bambu Cloud, then import again.";

export function parseMakerworldUrl(url: URL): string | null {
  if (!/(^|\.)makerworld\.com$/.test(url.hostname)) return null;
  const match = url.pathname.match(/\/models\/(\d+)/);
  return match ? match[1] : null;
}

type DesignPicture = { url?: string; name?: string };
type DesignInstance = { id?: number; profileId?: number; title?: string };

type MakerworldDesign = {
  id?: number;
  modelId?: string;
  title?: string;
  summary?: string;
  summaryTranslated?: string;
  tags?: string[];
  tagsTranslated?: string[];
  coverUrl?: string;
  designExtension?: { design_pictures?: DesignPicture[] };
  instances?: DesignInstance[];
  defaultInstanceId?: number;
};

export type MakerworldOptions = {
  token?: string;
  region?: BambuRegion;
};

function ensure3mf(name: string, fallback: string): string {
  const clean = name.trim();
  if (clean.toLowerCase().endsWith(".3mf")) return clean;
  return `${(clean || fallback).replace(/\.[^.]*$/, "")}.3mf`;
}

// Resolves each print profile to a presigned download URL. Returns the model
// assets plus any warnings (e.g. an expired login) to surface to the user.
async function resolveDownloads(
  design: MakerworldDesign,
  token: string,
  region: BambuRegion,
): Promise<{ assets: RemoteAsset[]; warnings: string[] }> {
  const assets: RemoteAsset[] = [];
  const warnings: string[] = [];

  const modelId = design.modelId;
  const instances = (design.instances ?? []).filter(
    (i): i is { profileId: number; title?: string } =>
      typeof i.profileId === "number",
  );
  if (!modelId || instances.length === 0) {
    warnings.push("No downloadable print profiles were found for this model.");
    return { assets, warnings };
  }

  const seen = new Set<number>();
  for (const instance of instances) {
    if (assets.length >= MAX_FILES) {
      warnings.push(`Only the first ${MAX_FILES} print profiles were imported.`);
      break;
    }
    if (seen.has(instance.profileId)) continue;
    seen.add(instance.profileId);

    const result = await fetchProfileDownload(
      instance.profileId,
      modelId,
      token,
      region,
    );
    if (result === "unauthorized") {
      warnings.push(BAMBU_EXPIRED_WARNING);
      break;
    }
    if (!result) {
      warnings.push(
        `Could not get a download for "${instance.title ?? instance.profileId}".`,
      );
      continue;
    }
    assets.push({
      url: result.url,
      filename: ensure3mf(result.name, instance.title ?? `profile-${instance.profileId}`),
      kind: "model",
    });
  }

  if (assets.length === 0 && warnings.length === 0) {
    warnings.push("No .3mf files could be downloaded for this model.");
  }
  return { assets, warnings };
}

export async function importFromMakerworld(
  url: URL,
  options: MakerworldOptions = {},
): Promise<ImportedProject> {
  const id = parseMakerworldUrl(url);
  if (!id) {
    throw new ImportError(
      "Could not find a model id in the MakerWorld URL (expected makerworld.com/…/models/<id>)",
    );
  }

  const region: BambuRegion = options.region ?? "global";
  const res = await fetch(`${apiBase(region)}/v1/design-service/design/${id}`, {
    headers: {
      "User-Agent": IMPORT_USER_AGENT,
      Accept: "application/json",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new ImportError(
      `MakerWorld API responded with ${res.status}. ` +
        "Download the .3mf in your browser instead and upload it — its metadata is imported automatically.",
    );
  }

  let design: MakerworldDesign;
  try {
    design = (await res.json()) as MakerworldDesign;
  } catch {
    throw new ImportError("Could not read model data from the MakerWorld API");
  }

  // The API returns an empty envelope (id: 0) for ids that don't exist.
  if (!design.id || !design.title) {
    throw new ImportError("MakerWorld model not found");
  }

  const pictures = design.designExtension?.design_pictures ?? [];
  const images = pictures
    .map((p) => p.url)
    .filter((u): u is string => typeof u === "string" && u.startsWith("http"))
    .slice(0, MAX_IMAGES);
  if (images.length === 0 && design.coverUrl?.startsWith("http")) {
    images.push(design.coverUrl);
  }

  const tags = (design.tags ?? design.tagsTranslated ?? [])
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  const assets: RemoteAsset[] = images.map((imageUrl, i) => ({
    url: imageUrl,
    filename: imageUrl.split("/").pop()?.split("?")[0] || `image-${i + 1}.jpg`,
    kind: "image",
  }));

  const warnings: string[] = [];
  if (options.token) {
    const downloads = await resolveDownloads(design, options.token, region);
    assets.push(...downloads.assets);
    warnings.push(...downloads.warnings);
  } else {
    warnings.push(
      "Connect your Bambu account (Settings → Bambu Cloud) to download the .3mf automatically — metadata and images were imported; add the .3mf manually for now.",
    );
  }

  return {
    source: "makerworld",
    sourceUrl: url.toString(),
    title: design.title.trim(),
    description: htmlishToMarkdown(design.summary ?? design.summaryTranslated ?? ""),
    tags,
    assets,
    warnings,
  };
}
