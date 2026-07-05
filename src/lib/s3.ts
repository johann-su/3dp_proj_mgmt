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

// 3mf is the primary format: a container with embedded metadata/images, which
// keeps the upload UI and ingestion simple (stl support was deliberately
// removed). step exists for the Onshape integration, whose exports are STEP
// files; the upload UI still only offers .3mf.
export const MODEL_EXTENSIONS = [".3mf", ".step", ".stp"];
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

export function fileExtension(filename: string) {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}
