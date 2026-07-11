import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseMakerworldUrl,
  preferEnglish,
  selectBomItems,
  selectDocs,
  selectImageUrls,
} from "@/lib/import/makerworld";

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
