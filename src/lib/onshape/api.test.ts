import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildExportRequest,
  isOnshapeId,
  onshapeDocumentUrl,
  parseOnshapeUrl,
} from "@/lib/onshape/api";

const DID = "0123456789abcdef01234567";
const WID = "89abcdef0123456789abcdef";
const EID = "fedcba9876543210fedcba98";

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
});

test("buildExportRequest uses the assemblies resource for assembly tabs", () => {
  const { path } = buildExportRequest(
    "ASSEMBLY",
    { documentId: DID, wvm: "v", wvmId: WID },
    EID,
  );
  assert.equal(path, `/assemblies/d/${DID}/v/${WID}/e/${EID}/translations`);
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
