import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  collectScadModelFiles,
  importFromMakerworld,
  parseMakerworldUrl,
  preferEnglish,
  selectBomItems,
  selectDocs,
  selectImageUrls,
} from "@/lib/import/makerworld";

test("importFromMakerworld downloads the OpenSCAD source of parametric designs", async (t) => {
  // Parametric designs list their .scad under designExtension.model_files
  // (modelType "scad"); the raw-model download endpoint exchanges the design
  // id for a presigned URL of one zip with every raw file (modelType=all is
  // the only value the API accepts — "scad" answers 404). The staged asset
  // carries extractScad so staging pulls just the .scad entries out.
  const design = {
    id: 777516,
    modelId: "US31d64271d31f2",
    title: "Customizable Servo Horn",
    instances: [{ id: 1, profileId: 42, title: "Default" }],
    designExtension: {
      model_files: [
        { modelName: "Standard Sizes.3mf", modelType: "3mf" },
        { modelName: "Custom Servo Horn.scad", modelType: "scad" },
      ],
    },
  };
  t.mock.method(globalThis, "fetch", async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.includes("/design-service/design/777516/model?modelType=all")) {
      // the live API returns an empty name for the zip download
      return Response.json({ name: "", url: "https://cdn.example/all.zip" });
    }
    if (url.includes("/iot-service/api/user/profile/42")) {
      return Response.json({ name: "Default.3mf", url: "https://cdn.example/p.3mf" });
    }
    if (url.includes("/design-service/design/777516")) {
      return Response.json(design);
    }
    return new Response("not found", { status: 404 });
  });

  const project = await importFromMakerworld(
    new URL("https://makerworld.com/en/models/777516-customizable-servo-horn"),
    { token: "token" },
  );
  const scad = project.assets.find((a) => a.extractScad);
  assert.ok(scad, "raw-files asset imported");
  assert.equal(scad.url, "https://cdn.example/all.zip");
  assert.equal(scad.kind, "model");
  // empty API name falls back to the scad entry's own filename
  assert.equal(scad.filename, "Custom Servo Horn.scad");
  // the sliced print profile still imports alongside the source
  assert.ok(project.assets.some((a) => a.filename === "Default.3mf"));
});

// The raw-model-file panel is a tree: makers group files under labelled
// folders, so a .scad frequently sits nested under a folder's `children`
// (here a "SCAD File" folder) rather than at the top level — where the top
// entries are the folders themselves (modelType ""). Missing these nested
// sources was why parametric models with many folders imported no .scad.
test("collectScadModelFiles finds .scad entries nested under folders", () => {
  const scad = collectScadModelFiles([
    {
      modelName: "",
      modelType: "", // a folder
      children: [{ modelName: "Raw.zip", modelType: "zip" }],
    },
    {
      modelName: "",
      modelType: "", // the "SCAD File" folder
      children: [
        { modelName: "Parametric Model Maker.scad", modelType: "scad" },
        { modelName: "Advanced Settings.scad", modelType: "scad" },
      ],
    },
    { modelName: "Top level.scad", modelType: "scad" }, // still found at the root
  ]);
  assert.deepEqual(
    scad.map((f) => f.modelName),
    ["Parametric Model Maker.scad", "Advanced Settings.scad", "Top level.scad"],
  );

  assert.deepEqual(collectScadModelFiles(undefined), []);
  assert.deepEqual(collectScadModelFiles([{ modelType: "3mf" }]), []);
});

// A popular design accumulates community-uploaded print profiles (no green
// "Designer" tag). We import only the designer's own — an instance whose
// author matches the design author — so other people's remixes aren't pulled
// in. That author filter, not a file count, is the primary limit. The .scad
// source imports regardless.
test("importFromMakerworld imports only the designer's own print profiles", async (t) => {
  const design = {
    id: 47599,
    modelId: "US31d64271d31f2",
    title: "Ultimate Gridfinity Bins",
    designCreator: { uid: 100 },
    instances: [
      { id: 1, profileId: 10, title: "Designer A", instanceCreator: { uid: 100 } },
      { id: 2, profileId: 11, title: "Community B", instanceCreator: { uid: 200 } },
      { id: 3, profileId: 12, title: "Designer C", instanceCreator: { uid: 100 } },
    ],
    designExtension: {
      // .scad nested under a folder, like the live Gridfinity model
      model_files: [
        {
          modelType: "",
          children: [{ modelName: "Parametric Model Maker.scad", modelType: "scad" }],
        },
      ],
    },
  };
  t.mock.method(globalThis, "fetch", async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.includes("/design-service/design/47599/model?modelType=all")) {
      return Response.json({ name: "", url: "https://cdn.example/all.zip" });
    }
    const profile = url.match(/\/iot-service\/api\/user\/profile\/(\d+)/);
    if (profile) {
      return Response.json({ name: `p${profile[1]}.3mf`, url: `https://cdn.example/${profile[1]}.3mf` });
    }
    if (url.includes("/design-service/design/47599")) {
      return Response.json(design);
    }
    return new Response("not found", { status: 404 });
  });

  const project = await importFromMakerworld(
    new URL("https://makerworld.com/en/models/47599-gridfinity"),
    { token: "token" },
  );
  const modelNames = project.assets.filter((a) => a.kind === "model").map((a) => a.filename);
  // the two designer profiles import; the community one (profile 11) does not
  assert.ok(modelNames.includes("p10.3mf"));
  assert.ok(modelNames.includes("p12.3mf"));
  assert.ok(!modelNames.includes("p11.3mf"));
  // and the nested .scad source still imports
  assert.ok(project.assets.some((a) => a.extractScad));
});

// The designer's-own filter is the only limit — there is no cap on how many of
// their profiles import. But a model with a lot of them (popular parametric
// models carry ~100) first stops for a Continue/Cancel confirmation so the user
// isn't surprised by a slow bulk download: without confirmation the importer
// resolves NO downloads and reports the projected count; with it, all import.
function manyProfilesDesign(count: number) {
  return {
    id: 999,
    modelId: "USdeadbeef",
    title: "Many Profiles",
    designCreator: { uid: 100 },
    instances: Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      profileId: 100 + i,
      title: `Designer ${i}`,
      instanceCreator: { uid: 100 },
    })),
  };
}

function mockManyProfilesFetch(t: TestContext, design: unknown) {
  t.mock.method(globalThis, "fetch", async (input: URL | RequestInfo) => {
    const url = String(input);
    const profile = url.match(/\/iot-service\/api\/user\/profile\/(\d+)/);
    if (profile) {
      return Response.json({ name: `p${profile[1]}.3mf`, url: `https://cdn.example/${profile[1]}.3mf` });
    }
    if (url.includes("/design-service/design/999")) {
      return Response.json(design);
    }
    return new Response("not found", { status: 404 });
  });
}

test("importFromMakerworld asks to confirm before importing a model with many files", async (t) => {
  mockManyProfilesFetch(t, manyProfilesDesign(15));

  const project = await importFromMakerworld(
    new URL("https://makerworld.com/en/models/999-many"),
    { token: "token" },
  );
  // Stopped before resolving any download; reports the projected file count.
  assert.equal(project.needsConfirmation, true);
  assert.equal(project.fileCount, 15);
  assert.equal(project.assets.filter((a) => a.kind === "model").length, 0);
});

test("importFromMakerworld imports all of the designer's own profiles once confirmed, no cap", async (t) => {
  mockManyProfilesFetch(t, manyProfilesDesign(15));

  const project = await importFromMakerworld(
    new URL("https://makerworld.com/en/models/999-many"),
    { token: "token", confirmManyFiles: true },
  );
  assert.ok(!project.needsConfirmation);
  // No cap: all 15 of the designer's own profiles import.
  assert.equal(project.assets.filter((a) => a.kind === "model").length, 15);
});

test("importFromMakerworld surfaces the design's category names leaf-first", async (t) => {
  // MakerWorld lists the leaf category before its parent; the importer keeps
  // that order so category suggestion can weight the most specific one.
  const design = {
    id: 605675,
    title: "Swift Logo Desktop Decoration",
    categories: [{ name: "Signs & Logos" }, { name: "Art" }],
  };
  t.mock.method(globalThis, "fetch", async () => Response.json(design));

  const project = await importFromMakerworld(
    new URL("https://makerworld.com/en/models/605675"),
  );
  assert.deepEqual(project.categories, ["Signs & Logos", "Art"]);
});

test("parseMakerworldUrl returns the model id for makerworld hosts", () => {
  assert.equal(
    parseMakerworldUrl(new URL("https://makerworld.com/en/models/12345-cool-thing")),
    "12345",
  );
  // subdomains count as makerworld
  assert.equal(
    parseMakerworldUrl(new URL("https://www.makerworld.com/models/678")),
    "678",
  );
});

// MakerWorld returns each text field as an original + a single English
// machine-translation; the translation is empty for already-English models. We
// import English when it exists, else the original — matching the site default.
test("preferEnglish uses the translation when present, else the original", () => {
  // non-English original → take the English translation
  assert.equal(preferEnglish("Model Airplane Rudder Angle", "航模舵角"), "Model Airplane Rudder Angle");
  // already-English model → translation is empty, fall back to the original
  assert.equal(preferEnglish("", "Isobutane stove stand"), "Isobutane stove stand");
  assert.equal(preferEnglish(undefined, "Isobutane stove stand"), "Isobutane stove stand");
  // whitespace-only translation is treated as absent
  assert.equal(preferEnglish("   ", "航模舵角"), "航模舵角");
  // nothing at all → empty string, never undefined
  assert.equal(preferEnglish(undefined, undefined), "");
});

// The cover (often the GIF) lives in coverUrl, separate from the gallery — it
// is the first media on the site and must lead the imported images, not be
// dropped when the gallery is non-empty (the original bug).
test("selectImageUrls leads with the cover, then the gallery, deduped", () => {
  const urls = selectImageUrls({
    coverUrl: "https://cdn/cover.gif",
    designExtension: {
      design_pictures: [{ url: "https://cdn/a.jpg" }, { url: "https://cdn/b.jpg" }],
    },
  });
  assert.deepEqual(urls, ["https://cdn/cover.gif", "https://cdn/a.jpg", "https://cdn/b.jpg"]);

  // cover already present in the gallery is not duplicated
  assert.deepEqual(
    selectImageUrls({
      coverUrl: "https://cdn/a.jpg",
      designExtension: { design_pictures: [{ url: "https://cdn/a.jpg" }] },
    }),
    ["https://cdn/a.jpg"],
  );

  // gallery-only (no cover) and non-http entries dropped
  assert.deepEqual(
    selectImageUrls({ designExtension: { design_pictures: [{ url: "data:x" }, { url: "https://cdn/a.jpg" }] } }),
    ["https://cdn/a.jpg"],
  );
});

// Attached PDFs (assembly guide, BOM sheet) import as document files. Both the
// guide and the BOM sheet live under designExtension as {name, url} links; a
// missing name falls back to the URL's filename, and non-http links are dropped.
test("selectDocs collects guide + BOM documents as pdf assets", () => {
  const docs = selectDocs({
    designExtension: {
      design_guide: [
        { name: "Assembly instructions.pdf", url: "https://cdn/guide.pdf" },
        { url: "https://cdn/61de923d.pdf" }, // no name → derive from URL
      ],
      design_bom: [{ name: "BOM.pdf", url: "https://cdn/bom.pdf" }],
    },
  });
  assert.deepEqual(docs, [
    { url: "https://cdn/guide.pdf", filename: "Assembly instructions.pdf", kind: "pdf" },
    { url: "https://cdn/61de923d.pdf", filename: "61de923d.pdf", kind: "pdf" },
    { url: "https://cdn/bom.pdf", filename: "BOM.pdf", kind: "pdf" },
  ]);

  // no documents / non-http links → nothing imported
  assert.deepEqual(selectDocs({ designExtension: {} }), []);
  assert.deepEqual(
    selectDocs({ designExtension: { design_guide: [{ url: "data:x" }] } }),
    [],
  );
});

// The structured BOM is split across product arrays (purchasable kits,
// filaments, materials) plus a hand-listed "other parts" list. Products carry a
// store link (handle) and image; other parts are name + quantity only. Each
// group becomes its own section so the BOM mirrors the source layout.
test("selectBomItems flattens the structured BOM into sectioned rows", () => {
  const items = selectBomItems({
    designExtension: {
      boms_v2: [
        {
          spuName: "CyberBrick Hardware Kit",
          handle: "cyberbrick-hardware-kit",
          quantity: 1,
          productSkuList: [{ image: "https://store/kit.png" }],
        },
      ],
      boms_of_filaments_v2: [
        { spuName: "PLA Metal", handle: "pla-metal", quantity: 2, productSkuList: [] },
      ],
      boms_of_other_part_list: [
        { name: "Lubricating Grease", nameTranslated: "", quantity: 1 },
      ],
    },
  });
  assert.deepEqual(items, [
    {
      name: "CyberBrick Hardware Kit",
      quantity: "1",
      link: "https://store.bambulab.com/products/cyberbrick-hardware-kit",
      imageUrl: "https://store/kit.png",
      section: "Hardware",
    },
    {
      name: "PLA Metal",
      quantity: "2",
      link: "https://store.bambulab.com/products/pla-metal",
      imageUrl: null,
      section: "Filament",
    },
    {
      name: "Lubricating Grease",
      quantity: "1",
      link: null,
      imageUrl: null,
      section: "Other parts",
    },
  ]);

  // no BOM → empty list (models without one)
  assert.deepEqual(selectBomItems({ designExtension: {} }), []);
});

test("parseMakerworldUrl rejects non-makerworld or non-model URLs", () => {
  assert.equal(parseMakerworldUrl(new URL("https://example.com/models/1")), null);
  assert.equal(parseMakerworldUrl(new URL("https://makerworld.com/en/search")), null);
  // guards against a look-alike host
  assert.equal(parseMakerworldUrl(new URL("https://notmakerworld.com/models/1")), null);
});
