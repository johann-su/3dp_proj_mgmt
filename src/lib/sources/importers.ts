// The server half of the source registry (src/lib/sources/registry.ts): how a
// pasted URL becomes an ImportedProject for each source. POST /api/import
// only dispatches to these — it knows nothing about any one platform — so a
// new source is a descriptor plus an importer here.
//
// An importer may need a round-trip before it can import (Onshape asks which
// tabs and branch to export). It then answers with a `prompt`: a JSON body the
// route returns as-is, which the import form recognizes, shows a dialog for,
// and re-POSTs with the answer in extra body fields. Those fields reach the
// importer untouched in `body`, untrusted — each importer validates its own.

import {
  BAMBU_EXPIRED_WARNING,
  importFromMakerworld,
} from "@/lib/import/makerworld";
import { importFromPrintables } from "@/lib/import/printables";
import {
  importFromOnshape,
  listOnshapeImportTabs,
  type OnshapeBranchPick,
  type OnshapeImportTab,
} from "@/lib/import/onshape";
import {
  MAX_EXPORT_ELEMENTS,
  type OnshapeBranchChoice,
} from "@/lib/onshape/api";
import { getOnshapeAccessToken } from "@/lib/onshape/credentials";
import {
  getBambuCredential,
  markBambuCredentialInvalid,
} from "@/lib/bambu/credentials";
import type { ImportedProject } from "@/lib/import/types";
import {
  isOnshapeId,
  parseMakerworldCollectionUrl,
  parseMakerworldUrl,
  parseOnshapeUrl,
  parsePrintablesUrl,
  type SourcePlatform,
} from "./registry";

export type ImportRequest = {
  userId: string;
  // Set once the user has agreed to import a model with a lot of files (the
  // Continue/Cancel prompt in import-form.tsx).
  confirmManyFiles: boolean;
  // The whole request body, for source-specific answers to an earlier prompt.
  body: Record<string, unknown>;
};

export type ImportStep =
  | { project: ImportedProject }
  | { prompt: Record<string, unknown> };

export type SourceImporter = {
  source: SourcePlatform;
  // A URL this importer takes (a design/document link, not just any page on
  // the source's site).
  matches(url: URL): boolean;
  // Why a URL on this source's site can't be imported here, when there is a
  // more useful answer than "unsupported" (a collection link has its own
  // import flow).
  rejection?(url: URL): string | null;
  importUrl(url: URL, request: ImportRequest): Promise<ImportStep>;
};

// --- MakerWorld --------------------------------------------------------------

const makerworld: SourceImporter = {
  source: "makerworld",
  matches: (url) => parseMakerworldUrl(url) !== null,
  rejection: (url) =>
    parseMakerworldCollectionUrl(url)
      ? "That link is a MakerWorld collection — use the “Import collection” option instead"
      : null,
  async importUrl(url, { userId, confirmManyFiles }) {
    // File downloads need the user's Bambu Cloud login; without one only the
    // metadata and images come across.
    const cred = await getBambuCredential(userId);
    const project = await importFromMakerworld(
      url,
      cred
        ? { token: cred.token, region: cred.region, confirmManyFiles }
        : { confirmManyFiles },
    );
    // Bambu rejected the stored token — flag it so the renewal reminder shows.
    if (cred && project.warnings.includes(BAMBU_EXPIRED_WARNING)) {
      await markBambuCredentialInvalid(userId);
    }
    return { project };
  },
};

// --- Printables ----------------------------------------------------------------

const printables: SourceImporter = {
  source: "printables",
  matches: (url) => parsePrintablesUrl(url) !== null,
  async importUrl(url, { confirmManyFiles }) {
    const id = parsePrintablesUrl(url)!;
    return { project: await importFromPrintables(url, id, { confirmManyFiles }) };
  },
};

// --- Onshape -------------------------------------------------------------------

// First-POST answer for a multi-tab or multi-branch Onshape document: the
// client shows the tab-selection dialog and re-POSTs with `onshapeElements`
// (plus `onshapeWvm`/`onshapeWvmId` when a branch/version was picked).
export type OnshapeSelectionResponse = {
  needsOnshapeSelection: true;
  title: string;
  tabs: OnshapeImportTab[];
  // Server-side export cap (MAX_EXPORT_ELEMENTS) — the dialog stops the user
  // from selecting more instead of silently truncating.
  maxTabs: number;
  // Branch/version dropdown entries and the one the tab list was read from;
  // picking another re-requests this listing (each branch has its own tabs).
  branches: OnshapeBranchChoice[];
  selected: OnshapeBranchPick;
};

const onshape: SourceImporter = {
  source: "onshape",
  matches: (url) => parseOnshapeUrl(url) !== null,
  async importUrl(url, { userId, body }) {
    const pin = parseOnshapeUrl(url)!;
    // The tabs picked in the selection dialog. Absent on the first POST — the
    // answer is then the document's tab list instead of an import.
    const elements = Array.isArray(body.onshapeElements)
      ? body.onshapeElements.filter((v): v is string => typeof v === "string")
      : null;
    // The branch/version picked in the dialog's dropdown — overrides the URL's
    // /w|v/ pin for both the tab listing and the import.
    const branch: OnshapeBranchPick | null =
      (body.onshapeWvm === "w" || body.onshapeWvm === "v") &&
      isOnshapeId(body.onshapeWvmId)
        ? { wvm: body.onshapeWvm, wvmId: body.onshapeWvmId }
        : null;

    const accessToken = await getOnshapeAccessToken(userId);
    const auth = accessToken ? { accessToken } : null;

    if (elements) {
      return {
        project: await importFromOnshape(pin, auth, {
          selectedElementIds: elements,
          branch,
        }),
      };
    }

    // First POST (or a branch switch from the dialog). A document with one tab
    // and no other branches/versions has nothing to choose — import it,
    // passing the tab explicitly so an ineligible pinned tab (URL copied on
    // e.g. a Variable Studio) can't derail the export.
    const { title, tabs, branches, selected } = await listOnshapeImportTabs(
      pin,
      auth,
      branch,
    );
    if (tabs.length > 1 || branches.length > 1) {
      return {
        prompt: {
          needsOnshapeSelection: true,
          title,
          tabs,
          maxTabs: MAX_EXPORT_ELEMENTS,
          branches,
          selected,
        } satisfies OnshapeSelectionResponse,
      };
    }
    return {
      project: await importFromOnshape(pin, auth, {
        selectedElementIds: tabs.map((t) => t.id),
        branch,
      }),
    };
  },
};

export const IMPORTERS: readonly SourceImporter[] = [makerworld, printables, onshape];

export function importerForUrl(url: URL): SourceImporter | null {
  return IMPORTERS.find((importer) => importer.matches(url)) ?? null;
}

// The most specific reason no importer takes this URL, if any source has one.
export function importRejection(url: URL): string | null {
  for (const importer of IMPORTERS) {
    const reason = importer.rejection?.(url);
    if (reason) return reason;
  }
  return null;
}
