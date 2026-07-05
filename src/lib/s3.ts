import { S3Client } from "@aws-sdk/client-s3";

export const s3 = new S3Client({
  region: process.env.S3_REGION ?? "us-east-1",
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
  },
  // Non-AWS servers (Garage) return bogus x-amz-checksum-* headers that trip
  // the SDK's default flexible-checksum validation.
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

export const S3_BUCKET = process.env.S3_BUCKET ?? "models";

// 3mf only: it's a container with embedded metadata/images, which keeps the
// upload UI and ingestion simple (stl/step support was deliberately removed).
export const MODEL_EXTENSIONS = [".3mf"];
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
// Optional documents attached to a model (build instructions, manual, …)
export const PDF_EXTENSIONS = [".pdf"];

export function allowedExtensions(kind: "model" | "image" | "pdf") {
  return kind === "model"
    ? MODEL_EXTENSIONS
    : kind === "pdf"
      ? PDF_EXTENSIONS
      : IMAGE_EXTENSIONS;
}

export function fileExtension(filename: string) {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}
