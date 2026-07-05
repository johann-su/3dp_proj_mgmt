export type RemoteAsset = {
  url: string;
  filename: string;
  kind: "model" | "image";
};

export type ImportedProject = {
  source: "makerworld" | "printables";
  sourceUrl: string;
  title: string;
  description: string;
  tags: string[];
  assets: RemoteAsset[];
  warnings: string[];
};

export class ImportError extends Error {}

export const IMPORT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
