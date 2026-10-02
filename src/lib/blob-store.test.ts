import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStorageConfig } from "@/lib/blob-store";

// Instances configured before the filesystem backend existed set only S3_*
// variables; they must keep storing to S3 without touching their config.
test("no STORAGE_BACKEND means S3, configured from the S3_* variables", () => {
  const config = resolveStorageConfig({
    S3_ENDPOINT: "http://garage:3900",
    S3_REGION: "garage",
    S3_BUCKET: "files",
    S3_ACCESS_KEY_ID: "id",
    S3_SECRET_ACCESS_KEY: "secret",
    S3_FORCE_PATH_STYLE: "true",
  });
  assert.deepEqual(config, {
    backend: "s3",
    endpoint: "http://garage:3900",
    region: "garage",
    bucket: "files",
    accessKeyId: "id",
    secretAccessKey: "secret",
    forcePathStyle: true,
  });
});

// compose.yml no longer enforces the S3_* variables (they're unused with the
// filesystem backend), so a missing credential must fail loudly here instead
// of sending unsigned requests.
test("S3 without credentials is a configuration error", () => {
  assert.throws(() => resolveStorageConfig({ S3_ENDPOINT: "http://minio:9000" }));
  assert.throws(() =>
    resolveStorageConfig({ STORAGE_BACKEND: "s3", S3_ACCESS_KEY_ID: "id" }),
  );
});

test("filesystem backend stores under STORAGE_PATH", () => {
  assert.deepEqual(
    resolveStorageConfig({ STORAGE_BACKEND: "filesystem", STORAGE_PATH: "/data/files" }),
    { backend: "filesystem", root: "/data/files" },
  );
});

// Silently falling back to some default directory would put uploads on the
// container's ephemeral layer, where the next redeploy deletes them.
test("filesystem backend without STORAGE_PATH is a configuration error", () => {
  assert.throws(() => resolveStorageConfig({ STORAGE_BACKEND: "filesystem" }));
  assert.throws(() =>
    resolveStorageConfig({ STORAGE_BACKEND: "filesystem", STORAGE_PATH: "  " }),
  );
});

test("an unknown STORAGE_BACKEND is rejected rather than defaulted", () => {
  assert.throws(() => resolveStorageConfig({ STORAGE_BACKEND: "gcs" }), /gcs/);
});
