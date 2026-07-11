// MakerWorld importer — reads metadata + images from the public Bambu design
// API (api.bambulab.com), which returns JSON anonymously and is NOT behind the
// Cloudflare bot wall that guards makerworld.com HTML pages.
//
// File downloads require an authenticated Bambu Cloud account. When the user
// has connected one (Settings → Bambu Cloud), each print profile is exchanged
// for a short-lived presigned URL and imported as a .3mf; otherwise only
// metadata + images are imported and the user adds the .3mf manually.

import { htmlishToMarkdown } from "@/lib/html";
import type { BomItemInput } from "@/lib/bom";
import {
  apiBase,
  fetchProfileDownload,
  fetchRawModelDownload,
  type BambuRegion,
} from "@/lib/bambu/cloud";
import { ImportError, IMPORT_USER_AGENT, type ImportedProject, type RemoteAsset } from "./types";

const MAX_IMAGES = 8;
const MAX_FILES = 8;
const MAX_DOCS = 8;

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

// A downloadable document attached to a design (assembly guide / BOM sheet).
type DesignDoc = { name?: string; url?: string };

// One purchasable BOM entry from the MakerWorld store (hardware kit, filament,
// material). The `*_v2` arrays all share this shape; the human-facing product
// name is `spuName`, the store product page is keyed by `handle`, and the
// gallery/thumbnail image lives on the first concrete SKU.
type BomProduct = {
  spuName?: string;
  handle?: string;
  quantity?: number;
  productSkuList?: { image?: string }[];
};

// A non-purchasable "other part" the maker lists by hand (grease, glue, …).
type BomOtherPart = {
  name?: string;
  nameTranslated?: string;
  quantity?: number;
};

// One raw model file of a design (the "raw model files" panel): unsliced
// geometry or, for parametric models, the OpenSCAD source (modelType "scad").
type DesignModelFile = {
  modelName?: string;
  modelType?: string;
};

type DesignExtension = {
  design_pictures?: DesignPicture[];
  model_files?: DesignModelFile[];
  // Attached documents: assembly guide(s) and, when the maker uploads one, a
  // BOM sheet. Both are download links (usually PDFs).
  design_guide?: DesignDoc[];
  design_bom?: DesignDoc[];
  // Structured bill of materials, split by product kind.
  boms_v2?: BomProduct[];
  boms_of_filaments_v2?: BomProduct[];
  boms_of_materials_v2?: BomProduct[];
  boms_of_other_part_list?: BomOtherPart[];
};

type MakerworldDesign = {
  id?: number;
  modelId?: string;
  title?: string;
  titleTranslated?: string;
  summary?: string;
  summaryTranslated?: string;
  tags?: string[];
  tagsTranslated?: string[];
  coverUrl?: string;
  designExtension?: DesignExtension;
  instances?: DesignInstance[];
  defaultInstanceId?: number;
};

export type MakerworldOptions = {
  token?: string;
  region?: BambuRegion;
};

// MakerWorld's API returns each text field twice: the author's original plus a
// single pre-computed English machine-translation (`*Translated`). That English
// variant is the same regardless of Accept-Language — it is not a language
// picker — and it is empty for models the author already wrote in English. We
// mirror the site's default ("Content has been automatically translated") by
// preferring the English translation whenever it is present and falling back to
// the original otherwise.
export function preferEnglish(
  translated: string | undefined,
  original: string | undefined,
): string {
  return (translated?.trim() || original?.trim()) ?? "";
}

// Picks the ordered, deduped list of image URLs for a design. The cover (often
// an animated GIF) lives in `coverUrl`, separate from the `design_pictures`
// gallery — it is the model's first piece of media on the site, so it leads the
// list rather than only being a fallback when the gallery is empty.
export function selectImageUrls(design: MakerworldDesign, max = MAX_IMAGES): string[] {
  const pictures = design.designExtension?.design_pictures ?? [];
  const urls = [design.coverUrl, ...pictures.map((p) => p.url)].filter(
    (u): u is string => typeof u === "string" && u.startsWith("http"),
  );
  return [...new Set(urls)].slice(0, max);
}

// Picks the design's attached documents (assembly guide + BOM sheet) as PDF
// assets. Both live under `designExtension` as {name, url} download links; the
// staging step drops anything that isn't actually a .pdf.
export function selectDocs(design: MakerworldDesign, max = MAX_DOCS): RemoteAsset[] {
  const ext = design.designExtension;
  const docs = [...(ext?.design_guide ?? []), ...(ext?.design_bom ?? [])];
  const seen = new Set<string>();
  const assets: RemoteAsset[] = [];
  for (const doc of docs) {
    const url = doc.url;
    if (typeof url !== "string" || !url.startsWith("http") || seen.has(url)) continue;
    seen.add(url);
    const fallback = url.split("/").pop()?.split("?")[0] || `document-${assets.length + 1}.pdf`;
    assets.push({
      url,
      filename: (doc.name?.trim() || fallback),
      kind: "pdf",
    });
    if (assets.length >= max) break;
  }
  return assets;
}

// Bill of materials link on the Bambu store. `store.bambulab.com` 302-redirects
// to the visitor's regional store, so a single handle-based URL works globally.
function storeUrl(handle: string | undefined): string | null {
  const clean = handle?.trim();
  return clean ? `https://store.bambulab.com/products/${clean}` : null;
}

// Flattens MakerWorld's structured bill of materials into the app's BOM rows.
// The store products (hardware kits, filaments, materials) carry a name, a
// purchase link and a product image; hand-listed "other parts" are name +
// quantity only. Each group becomes a titled section, mirroring the site.
export function selectBomItems(design: MakerworldDesign): BomItemInput[] {
  const ext = design.designExtension;
  const items: BomItemInput[] = [];

  const addProducts = (products: BomProduct[] | undefined, section: string) => {
    for (const product of products ?? []) {
      const name = product.spuName?.trim();
      if (!name) continue;
      items.push({
        name,
        quantity: String(product.quantity ?? 1),
        link: storeUrl(product.handle),
        imageUrl: product.productSkuList?.find((s) => s.image)?.image ?? null,
        section,
      });
    }
  };

  addProducts(ext?.boms_v2, "Hardware");
  addProducts(ext?.boms_of_filaments_v2, "Filament");
  addProducts(ext?.boms_of_materials_v2, "Materials");

  for (const part of ext?.boms_of_other_part_list ?? []) {
    const name = preferEnglish(part.nameTranslated, part.name);
    if (!name) continue;
    items.push({
      name,
      quantity: String(part.quantity ?? 1),
      link: null,
      imageUrl: null,
      section: "Other parts",
    });
  }

  return items;
}

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
  }

  const seen = new Set<number>();
  if (modelId) {
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
  }

  if (assets.length === 0 && warnings.length === 0) {
    warnings.push("No .3mf files could be downloaded for this model.");
  }

  // Parametric designs also carry their OpenSCAD source as a raw model file —
  // import it so the model can be customized here (see AGENTS.md, OpenSCAD
  // service). Skipped silently when absent; failures are warnings like any
  // other download.
  const scadFiles = (design.designExtension?.model_files ?? []).filter(
    (f) => f.modelType === "scad",
  );
  if (scadFiles.length > 0 && typeof design.id === "number") {
    // Only modelType=all exists — the download is a zip of every raw file
    // (geometry included); staging extracts just the .scad entries from it.
    const result = await fetchRawModelDownload(design.id, "all", token, region);
    if (result === "unauthorized") {
      if (!warnings.includes(BAMBU_EXPIRED_WARNING)) {
        warnings.push(BAMBU_EXPIRED_WARNING);
      }
    } else if (!result) {
      warnings.push("Could not download the model's OpenSCAD source files.");
    } else {
      assets.push({
        url: result.url,
        filename:
          result.name.trim() ||
          scadFiles[0].modelName?.trim() ||
          "raw-files.zip",
        kind: "model",
        extractScad: true,
      });
    }
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

  const images = selectImageUrls(design);

  // Prefer the English tag set; it is empty only for already-English models.
  const tags = (design.tagsTranslated?.length ? design.tagsTranslated : design.tags ?? [])
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  const assets: RemoteAsset[] = images.map((imageUrl, i) => ({
    url: imageUrl,
    filename: imageUrl.split("/").pop()?.split("?")[0] || `image-${i + 1}.jpg`,
    kind: "image",
  }));

  // Attached PDFs (assembly guide / BOM sheet) import as document files.
  assets.push(...selectDocs(design));

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
    title: preferEnglish(design.titleTranslated, design.title),
    description: htmlishToMarkdown(preferEnglish(design.summaryTranslated, design.summary)),
    tags,
    assets,
    bom: selectBomItems(design),
    warnings,
  };
}
