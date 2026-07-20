import { test } from "node:test";
import assert from "node:assert/strict";
import {
  branchChoices,
  buildExportRequest,
  eligibleExportElements,
  isOnshapeId,
  MAX_EXPORT_ELEMENTS,
  onshapeDocumentUrl,
  parseOnshapeUrl,
  selectExportElements,
  type OnshapeExportElement,
} from "@/lib/onshape/api";

const DID = "0123456789abcdef01234567";
const WID = "89abcdef0123456789abcdef";
const EID = "fedcba9876543210fedcba98";

// 24-char hex ids, distinct per index.
const elementId = (n: number) => n.toString(16).padStart(24, "0");

const tab = (n: number, elementType: "PARTSTUDIO" | "ASSEMBLY"): OnshapeExportElement => ({
  id: elementId(n),
  name: `Tab ${n}`,
  elementType,
});

test("isOnshapeId accepts 24-char hex ids only", () => {
  assert.equal(isOnshapeId(DID), true);
  assert.equal(isOnshapeId("too-short"), false);
  assert.equal(isOnshapeId(DID.toUpperCase()), false); // hex is lower-case
  assert.equal(isOnshapeId(123), false);
});

test("parseOnshapeUrl extracts document/workspace/element pins", () => {
  const pin = parseOnshapeUrl(
    new URL(`https://cad.onshape.com/documents/${DID}/w/${WID}/e/${EID}`),
  );
  assert.deepEqual(pin, {
    documentId: DID,
    wvm: "w",
    wvmId: WID,
    elementId: EID,
  });
});

test("parseOnshapeUrl handles a bare document link (no w/v/e)", () => {
  const pin = parseOnshapeUrl(new URL(`https://cad.onshape.com/documents/${DID}`));
  assert.deepEqual(pin, {
    documentId: DID,
    wvm: null,
    wvmId: null,
    elementId: null,
  });
});

test("parseOnshapeUrl rejects other hosts", () => {
  assert.equal(parseOnshapeUrl(new URL(`https://example.com/documents/${DID}`)), null);
});

test("buildExportRequest sends 3MF through the generic translations route", () => {
  // There is no …/export/3mf endpoint (only glTF/OBJ/STEP have one); the
  // format must go in the body of …/translations instead.
  const { path, body } = buildExportRequest(
    "PARTSTUDIO",
    { documentId: DID, wvm: "w", wvmId: WID },
    EID,
  );
  assert.equal(path, `/partstudios/d/${DID}/w/${WID}/e/${EID}/translations`);
  assert.equal(body.formatName, "3MF");
  assert.equal(body.storeInDocument, false);
  // Mesh exports fail with "Invalid 3MF detail parameters" without these.
  assert.equal(body.resolution, "fine");
  assert.equal(body.unit, "millimeter");
});

test("buildExportRequest uses the assemblies resource for assembly tabs", () => {
  const { path } = buildExportRequest(
    "ASSEMBLY",
    { documentId: DID, wvm: "v", wvmId: WID },
    EID,
  );
  assert.equal(path, `/assemblies/d/${DID}/v/${WID}/e/${EID}/translations`);
});

test("eligibleExportElements keeps only Part Studio and Assembly tabs", () => {
  // Variable Studios, drawings, blobs etc. can't be exported as 3MF and must
  // never show up in the import dialog.
  const elements = eligibleExportElements([
    { id: elementId(1), name: "Part Studio 1", elementType: "PARTSTUDIO" },
    { id: elementId(2), name: "Variable Studio 1", elementType: "VARIABLESTUDIO" },
    { id: elementId(3), name: "Assembly 1", elementType: "ASSEMBLY" },
    { id: "not-a-real-id", name: "Broken", elementType: "PARTSTUDIO" },
  ]);
  assert.deepEqual(
    elements.map((e) => e.name),
    ["Part Studio 1", "Assembly 1"],
  );
});

test("selectExportElements: explicit selection wins over the pinned tab", () => {
  // The pin is just whichever tab was open when the URL was copied — the
  // dialog's choice (e.g. Part Studios, not the pinned Assembly) must win.
  const elements = [tab(1, "PARTSTUDIO"), tab(2, "PARTSTUDIO"), tab(3, "ASSEMBLY")];
  const { selected, warnings } = selectExportElements(elements, {
    pinnedElementId: elementId(3),
    selectedElementIds: [elementId(2), elementId(1)],
  });
  // Document tab order, not selection order.
  assert.deepEqual(selected.map((e) => e.id), [elementId(1), elementId(2)]);
  assert.deepEqual(warnings, []);
});

test("selectExportElements: selected tabs deleted upstream become a warning", () => {
  // Sync re-exports the tabs a model was imported with; a tab deleted in
  // Onshape is skipped with a warning (its file mirrors upstream and goes).
  const elements = [tab(1, "PARTSTUDIO")];
  const { selected, warnings } = selectExportElements(elements, {
    selectedElementIds: [elementId(1), elementId(9)],
  });
  assert.deepEqual(selected.map((e) => e.id), [elementId(1)]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no longer exist/);
});

test("selectExportElements: errors when no selected tab exists anymore", () => {
  assert.throws(() =>
    selectExportElements([tab(1, "PARTSTUDIO")], {
      selectedElementIds: [elementId(9)],
    }),
  );
});

test("selectExportElements: pinned tab only, when nothing is selected", () => {
  const elements = [tab(1, "PARTSTUDIO"), tab(2, "ASSEMBLY")];
  const { selected } = selectExportElements(elements, {
    pinnedElementId: elementId(2),
  });
  assert.deepEqual(selected.map((e) => e.id), [elementId(2)]);
});

test("selectExportElements: no pin and no selection exports all tabs, capped", () => {
  const elements = Array.from({ length: MAX_EXPORT_ELEMENTS + 2 }, (_, i) =>
    tab(i + 1, "PARTSTUDIO"),
  );
  const { selected, warnings } = selectExportElements(elements, {});
  assert.equal(selected.length, MAX_EXPORT_ELEMENTS);
  assert.equal(warnings.length, 1);
});

test("branchChoices lists branches first, then versions newest-first", () => {
  const choices = branchChoices(
    [{ id: elementId(1), name: "Main" }],
    [
      { id: elementId(2), name: "V1", parent: elementId(9), createdAt: "2026-01-01T00:00:00Z" },
      { id: elementId(3), name: "V2", parent: elementId(2), createdAt: "2026-06-01T00:00:00Z" },
    ],
  );
  assert.deepEqual(
    choices.map((c) => [c.wvm, c.name]),
    [
      ["w", "Main"],
      ["v", "V2"],
      ["v", "V1"],
    ],
  );
});

test("branchChoices drops the root Start version but keeps user versions named Start", () => {
  // Every document has an implicit root version "Start" (parent null) — the
  // empty initial state, pointless to import. A *user* version that merely
  // shares the name has a parent and must survive.
  const choices = branchChoices(
    [{ id: elementId(1), name: "Main" }],
    [
      { id: elementId(2), name: "Start", parent: null },
      { id: elementId(3), name: "Start", parent: elementId(2) },
    ],
  );
  assert.deepEqual(
    choices.map((c) => c.id),
    [elementId(1), elementId(3)],
  );
});

test("onshapeDocumentUrl round-trips a parsed pin", () => {
  const url = onshapeDocumentUrl({
    documentId: DID,
    wvm: "v",
    wvmId: WID,
    elementId: EID,
  });
  assert.equal(url, `https://cad.onshape.com/documents/${DID}/v/${WID}/e/${EID}`);
  const pin = parseOnshapeUrl(new URL(url));
  assert.equal(pin?.documentId, DID);
  assert.equal(pin?.wvm, "v");
});
