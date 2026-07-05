// Onshape importer — unlike MakerWorld/Printables there is no anonymous
// metadata API: every call needs the user's API key (Settings → Onshape).
// Metadata comes from the document info endpoint, the preview image from the
// document thumbnail, and the model files are asynchronous STEP exports of the
// pinned tab (…/e/{eid} in the URL) or of every Part Studio/Assembly tab.

import {
  exportPinnedSteps,
  getCurrentMicroversion,
  getDocument,
  onshapeAuthHeaders,
  onshapeDocumentUrl,
  OnshapeError,
  type OnshapeKeys,
  type OnshapePin,
} from "@/lib/onshape/api";
import { ImportError, type ImportedProject, type RemoteAsset } from "./types";

// Prefer a mid-size thumbnail; the tiny ones look bad as covers and the
// original ("0x0") can be missing.
const THUMBNAIL_PREFERENCE = ["600x340", "300x300", "300x170", "0x0", "70x40"];

function pickThumbnail(
  sizes: { size?: string; href?: string; mediaType?: string }[] | undefined,
): string | null {
  if (!sizes?.length) return null;
  for (const wanted of THUMBNAIL_PREFERENCE) {
    const match = sizes.find((s) => s.size === wanted && s.href?.startsWith("http"));
    if (match?.href) return match.href;
  }
  return sizes.find((s) => s.href?.startsWith("http"))?.href ?? null;
}

export async function importFromOnshape(
  pin: OnshapePin,
  keys: OnshapeKeys | null,
): Promise<ImportedProject> {
  if (!keys) {
    throw new ImportError(
      "Importing from Onshape needs your API key — connect it under Settings → Onshape first.",
    );
  }
  if (pin.wvm === "m") {
    throw new ImportError(
      "Microversion links (…/m/…) can't be imported — use a workspace (…/w/…) or version (…/v/…) link.",
    );
  }

  try {
    const document = await getDocument(keys, pin.documentId);

    // URLs without /w|v/ pin to the default workspace.
    let wvm = pin.wvm;
    let wvmId = pin.wvmId;
    if (!wvm || !wvmId) {
      const defaultWorkspace = document.defaultWorkspace?.id;
      if (!defaultWorkspace) {
        throw new ImportError("Could not resolve the document's default workspace");
      }
      wvm = "w";
      wvmId = defaultWorkspace;
    }

    const headers = onshapeAuthHeaders(keys);
    const assets: RemoteAsset[] = [];

    const thumbnail = pickThumbnail(document.thumbnail?.sizes);
    if (thumbnail) {
      assets.push({
        url: thumbnail,
        filename: "onshape-thumbnail.png",
        kind: "image",
        headers,
      });
    }

    // Read the microversion before exporting: if the document changes while we
    // export, the stored value is stale and the next sync picks the change up.
    const microversion =
      wvm === "w"
        ? await getCurrentMicroversion(keys, pin.documentId, wvm, wvmId)
        : null;

    const { exports, warnings } = await exportPinnedSteps(keys, {
      documentId: pin.documentId,
      wvm,
      wvmId,
      elementId: pin.elementId,
    });
    for (const file of exports) {
      assets.push({
        url: file.url,
        filename: file.filename,
        kind: "model",
        headers,
        onshapeElementId: file.elementId,
      });
    }

    return {
      source: "onshape",
      sourceUrl: onshapeDocumentUrl({
        documentId: pin.documentId,
        wvm,
        wvmId,
        elementId: pin.elementId,
      }),
      title: (document.name ?? "").trim() || "Onshape model",
      description: (document.description ?? "").trim(),
      tags: [],
      assets,
      warnings,
      onshapeMicroversion: microversion,
    };
  } catch (err) {
    if (err instanceof OnshapeError) throw new ImportError(err.message);
    throw err;
  }
}
