import type { UploadedFile } from "@/app/models/actions";

// Draft produced by /models/import and handed to the create form via
// sessionStorage. Files are already staged in S3 (UploadedFile shape).
export type ImportDraftPayload = {
  sourceUrl: string;
  title: string;
  description: string;
  tags: string[];
  files: UploadedFile[];
  warnings: string[];
};

export const IMPORT_DRAFT_KEY = "printvault-import-draft";
