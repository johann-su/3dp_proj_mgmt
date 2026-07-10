import { S3Client } from "@aws-sdk/client-s3";

export {
  MODEL_EXTENSIONS,
  IMAGE_EXTENSIONS,
  PDF_EXTENSIONS,
  allowedExtensions,
  contentTypeForFilename,
  fileExtension,
  sanitizeRename,
} from "@/lib/file-kind";

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
