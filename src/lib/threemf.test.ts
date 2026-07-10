import { test } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { extract3mfMetadata } from "@/lib/threemf";

function modelXml(metadata: string) {
  return strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
${metadata}
<resources/>
<build/>
</model>`);
}

// Image bytes are never decoded, any payload works.
const IMG = strToU8("fake-image-bytes");

function threeMf(entries: Record<string, Uint8Array>, filename = "test.3mf") {
  return new File([zipSync(entries) as unknown as BlobPart], filename);
}

// The Description keeps its formatting as Markdown (Bambu double-escapes the
// HTML: "&amp;lt;h3&amp;gt;…"); the Title is flattened to plain text.
test("extract3mfMetadata reads Title and a double-escaped HTML Description as markdown", async () => {
  const meta = await extract3mfMetadata(
    threeMf({
      "3D/3dmodel.model": modelXml(
        `<metadata name="Title">Cable Clip</metadata>
<metadata name="Description">&amp;lt;h3&amp;gt;Notes&amp;lt;/h3&amp;gt;&amp;lt;p&amp;gt;Snap fit, &amp;lt;strong&amp;gt;no supports&amp;lt;/strong&amp;gt;&amp;lt;/p&amp;gt;</metadata>`,
      ),
    }),
  );
  assert.equal(meta.title, "Cable Clip");
  assert.equal(meta.description, "### Notes\n\nSnap fit, **no supports**");
});

test("extract3mfMetadata falls back to a cleaned-up filename as title", async () => {
  const meta = await extract3mfMetadata(
    threeMf({ "3D/3dmodel.model": modelXml("") }, "Bambu_P1S_AMS_Flipper_V1.4.3mf"),
  );
  assert.equal(meta.title, "Bambu P1S AMS Flipper V1.4");
});

test("extract3mfMetadata derives a printer tag from project settings", async () => {
  const meta = await extract3mfMetadata(
    threeMf({
      "Metadata/project_settings.config": strToU8(
        JSON.stringify({ printer_model: "Bambu Lab X1 Carbon 0.4 nozzle" }),
      ),
    }),
  );
  assert.equal(meta.printerTag, "bambu x1c");
});

test("extract3mfMetadata falls back to the slice_info printer_model_id code", async () => {
  const meta = await extract3mfMetadata(
    threeMf({
      "Metadata/slice_info.config": strToU8(
        `<config><plate><metadata key="printer_model_id" value="C12"/></plate></config>`,
      ),
    }),
  );
  assert.equal(meta.printerTag, "bambu p1s");
});

test("extract3mfMetadata orders images (auxiliaries, plates, thumbnails) and skips avatars", async () => {
  const meta = await extract3mfMetadata(
    threeMf({
      "Metadata/thumbnail_middle.png": IMG,
      "Metadata/plate_10.png": IMG,
      "Metadata/plate_2.png": IMG,
      "Auxiliaries/Model Pictures/render.webp": IMG,
      "Auxiliaries/Profile Picture/avatar.png": IMG, // uploader avatar, not model imagery
    }),
  );
  assert.deepEqual(
    meta.images.map((f) => f.name),
    ["render.webp", "plate_2.png", "plate_10.png", "thumbnail_middle.png"],
  );
  assert.equal(meta.images[0].type, "image/webp");
});
