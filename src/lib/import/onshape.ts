// Onshape importer — unlike MakerWorld/Printables there is no anonymous
// metadata API: every call needs the user's OAuth token (Settings → Onshape).
// Metadata comes from the document info endpoint, the preview image from the
// document thumbnail, and the model files are asynchronous 3MF exports of the
// tabs the user picked in the import dialog (listOnshapeImportTabs feeds it) —
// falling back to the pinned tab (…/e/{eid} in the URL) or every Part
// Studio/Assembly tab when no selection is given.

import {
  branchChoices,
  eligibleExportElements,
  exportPinnedModels,
  getCurrentMicroversion,
  getDocument,
  getElements,
  getVersions,
  getWorkspaces,
  onshapeAuthHeaders,
  onshapeDocumentUrl,
  OnshapeError,
  type OnshapeAuth,
  type OnshapeBranchChoice,
  type OnshapeDocument,
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

function requireImportablePin(
  pin: OnshapePin,
  auth: OnshapeAuth | null,
): asserts auth is OnshapeAuth {
  if (!auth) {
    throw new ImportError(
      "Importing from Onshape needs a connected account — sign in with Onshape under Settings → Onshape first.",
    );
  }
  if (pin.wvm === "m") {
    throw new ImportError(
      "Microversion links (…/m/…) can't be imported — use a workspace (…/w/…) or version (…/v/…) link.",
    );
  }
}

// The branch/version the user picked in the import dialog's dropdown; it
// overrides whatever the pasted URL pins.
export type OnshapeBranchPick = { wvm: "w" | "v"; wvmId: string };

// The dialog's dropdown pick wins, then the URL's /w|v/ pin; URLs without
// one pin to the default workspace.
function resolveWorkspace(
  document: OnshapeDocument,
  pin: OnshapePin,
  branch?: OnshapeBranchPick | null,
): { wvm: "w" | "v"; wvmId: string } {
  if (branch) return { wvm: branch.wvm, wvmId: branch.wvmId };
  if (pin.wvm && pin.wvm !== "m" && pin.wvmId) {
    return { wvm: pin.wvm, wvmId: pin.wvmId };
  }
  const defaultWorkspace = document.defaultWorkspace?.id;
  if (!defaultWorkspace) {
    throw new ImportError("Could not resolve the document's default workspace");
  }
  return { wvm: "w", wvmId: defaultWorkspace };
}

// One entry per importable tab, in document tab order — drives the import
// form's tab-selection dialog. `pinned` marks the tab the pasted URL was
// copied from (Onshape URLs always carry the open tab's /e/{eid}), which is
// not a deliberate choice — the dialog preselects Part Studios instead and
// leaves Assemblies off, since assembly exports place parts at their mated
// positions and interlocking parts come out overlapping when sliced.
export type OnshapeImportTab = {
  id: string;
  name: string;
  elementType: "PARTSTUDIO" | "ASSEMBLY";
  pinned: boolean;
};

export async function listOnshapeImportTabs(
  pin: OnshapePin,
  auth: OnshapeAuth | null,
  branch?: OnshapeBranchPick | null,
): Promise<{
  title: string;
  tabs: OnshapeImportTab[];
  // Dropdown entries (workspaces + versions) and the branch the tab list was
  // read from — the dialog re-requests this listing when the pick changes,
  // since each branch has its own tabs.
  branches: OnshapeBranchChoice[];
  selected: OnshapeBranchPick;
}> {
  requireImportablePin(pin, auth);
  try {
    const [document, workspaces, versions] = await Promise.all([
      getDocument(auth, pin.documentId),
      getWorkspaces(auth, pin.documentId),
      getVersions(auth, pin.documentId),
    ]);
    const { wvm, wvmId } = resolveWorkspace(document, pin, branch);
    const elements = eligibleExportElements(
      await getElements(auth, pin.documentId, wvm, wvmId),
    );
    return {
      title: (document.name ?? "").trim() || "Onshape model",
      tabs: elements.map((e) => ({
        id: e.id,
        name: e.name || e.id,
        elementType: e.elementType,
        pinned: e.id === pin.elementId,
      })),
      branches: branchChoices(workspaces, versions),
      selected: { wvm, wvmId },
    };
  } catch (err) {
    if (err instanceof OnshapeError) throw new ImportError(err.message);
    throw err;
  }
}

export async function importFromOnshape(
  pin: OnshapePin,
  auth: OnshapeAuth | null,
  opts?: {
    selectedElementIds?: string[] | null;
    branch?: OnshapeBranchPick | null;
  },
): Promise<ImportedProject> {
  requireImportablePin(pin, auth);

  try {
    const document = await getDocument(auth, pin.documentId);
    const { wvm, wvmId } = resolveWorkspace(document, pin, opts?.branch);

    const headers = onshapeAuthHeaders(auth);
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
        ? await getCurrentMicroversion(auth, pin.documentId, wvm, wvmId)
        : null;

    const { exports, warnings } = await exportPinnedModels(
      auth,
      {
        documentId: pin.documentId,
        wvm,
        wvmId,
        elementId: pin.elementId,
      },
      opts?.selectedElementIds,
    );
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
      // Onshape has no model taxonomy — the suggestion falls back to
      // title/tag keywords, then "Other".
      categories: [],
      assets,
      bom: [],
      warnings,
      onshapeMicroversion: microversion,
    };
  } catch (err) {
    if (err instanceof OnshapeError) throw new ImportError(err.message);
    throw err;
  }
}
