import { Box, Boxes, FileArchive, Shapes, type LucideIcon } from "lucide-react";

// The import entry points. Each is a distinct source/shape of thing being
// imported — a single model, a whole collection, a CAD document, or a .zip
// this app exported — so the sidebar offers them as explicit choices instead
// of one ambiguous "paste any URL" field. The chosen type flows to
// /models/import?type=… and drives the page copy, whether the form takes a URL
// or a file, and which endpoint it submits to.
export type ImportType = "model" | "collection" | "cad" | "archive";

export type ImportTypeConfig = {
  type: ImportType;
  // Sidebar option label + the sources shown as its subtext.
  label: string;
  sources: string;
  icon: LucideIcon;
  // What the form asks for: a pasted URL, or a file picked from disk.
  input: "url" | "file";
  // File input only — the accept attribute.
  accept?: string;
  // Import-page copy.
  heading: string;
  intro: string;
  inputLabel: string;
  placeholder: string;
  hint: string;
  submitLabel: string;
  fetchingLabel: string;
};

export const IMPORT_TYPES = {
  model: {
    type: "model",
    label: "Import Model",
    sources: "MakerWorld / Printables",
    icon: Box,
    input: "url",
    heading: "Import Model",
    intro:
      "Paste a MakerWorld or Printables model link. The model info, images and files are fetched and prefilled into the create form.",
    inputLabel: "Model URL",
    placeholder: "https://www.printables.com/model/3161-3d-benchy",
    hint: "Supports Printables and MakerWorld single-model links.",
    submitLabel: "Fetch model",
    fetchingLabel: "Fetching model… this can take a moment",
  },
  collection: {
    type: "collection",
    label: "Import Collection",
    sources: "MakerWorld",
    icon: Boxes,
    input: "url",
    heading: "Import Collection",
    intro:
      "Paste a MakerWorld collection link. Every model in it imports in the background into a new collection here.",
    inputLabel: "Collection URL",
    placeholder: "https://makerworld.com/en/collections/12345",
    hint: "Supports MakerWorld collection links. Requires a connected Bambu account.",
    submitLabel: "Import collection",
    fetchingLabel: "Starting import…",
  },
  cad: {
    type: "cad",
    label: "Import CAD",
    sources: "Onshape",
    icon: Shapes,
    input: "url",
    heading: "Import CAD",
    intro:
      "Paste an Onshape document link, then pick the Part Studio or Assembly tabs to import — each exports as its own .3mf file.",
    inputLabel: "Document URL",
    placeholder: "https://cad.onshape.com/documents/…",
    hint: "Supports Onshape document links. Requires a connected Onshape account.",
    submitLabel: "Fetch CAD",
    fetchingLabel: "Fetching CAD… this can take a moment",
  },
  archive: {
    type: "archive",
    label: "Import Archive",
    sources: "Print Vault .zip export",
    icon: FileArchive,
    input: "file",
    accept: ".zip",
    heading: "Import Archive",
    intro:
      "Upload a .zip exported from Print Vault — here or on another instance. Its files, images, description, tags and BOM are read back out and prefilled into the create form.",
    inputLabel: "Archive file",
    placeholder: "",
    hint: "Accepts the .zip produced by a model's Export button.",
    submitLabel: "Read archive",
    fetchingLabel: "Reading archive… this can take a moment",
  },
} satisfies Record<ImportType, ImportTypeConfig>;

// Display order for the sidebar menu (Record iteration order isn't a contract).
export const IMPORT_TYPE_ORDER: readonly ImportType[] = [
  "model",
  "collection",
  "cad",
  "archive",
];

// Falls back to the single-model import for an unknown/absent `?type=`.
export function resolveImportType(raw: string | undefined | null): ImportType {
  return raw === "collection" || raw === "cad" || raw === "archive" ? raw : "model";
}
