import type { UploadedFile } from "@/app/models/actions";
import type { BomItemInput } from "@/lib/bom";

// Draft produced by /models/import and handed to the create form via
// sessionStorage. Files are already staged in S3 (UploadedFile shape).
export type ImportDraftPayload = {
  sourceUrl: string;
  title: string;
  description: string;
  tags: string[];
  // Source platform category names (most specific first); used to suggest a
  // category in the form. May be absent in drafts written by older sessions.
  categories?: string[];
  files: UploadedFile[];
  // Bill of materials scraped from the source; empty when none.
  bom?: BomItemInput[];
  warnings: string[];
  // Onshape imports only — stored on the model to enable "Sync from Onshape".
  onshapeMicroversion?: string | null;
  // Existing models this import was flagged as a duplicate of and imported
  // anyway (issue #118); recorded on save for later admin review.
  duplicateOfIds?: string[];
};

export const IMPORT_DRAFT_KEY = "printvault-import-draft";
