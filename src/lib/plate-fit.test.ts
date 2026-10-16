import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { exceedsBed, measureBounds } from "@/lib/plate-fit";

// A part that tapers to a point at both ends — an octahedron stretched along X,
// standing in for a fuselage section — turned `deg` degrees in the bed plane,
// which is how a slicer fits a part longer than the bed's edge onto a square
// plate. The taper is the point: a box fills its own bounding box and rotates
// without loss, but a real part is narrow where it is longest, so its extreme
// point in one bed axis is nowhere near its extreme in the other.
function diagonalTaperedPart(length: number, width: number, deg: number) {
  const geometry = new THREE.OctahedronGeometry(1);
  geometry.scale(length / 2, width / 2, width / 2);
  const mesh = new THREE.Mesh(geometry);
  mesh.rotation.z = THREE.MathUtils.degToRad(deg);
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

// The regression this module exists for. three's default (non-precise)
// Box3.setFromObject measures the box *around the rotated bounding box*, so a
// diagonal part's footprint comes out as its box's diagonal span rather than
// its own — here ~170 mm instead of the ~156 mm it really covers.
test("measureBounds measures a rotated part from its vertices, not its box", () => {
  const group = diagonalTaperedPart(200, 40, 45);

  const size = measureBounds(group).getSize(new THREE.Vector3());
  // Only the two tips reach out that far, so the footprint is the 200 mm
  // length swung to 45°: 200·cos45 ≈ 141.4 mm on both bed axes.
  assert.ok(Math.abs(size.x - 141.4) < 0.1, `x was ${size.x}`);
  assert.ok(Math.abs(size.y - 141.4) < 0.1, `y was ${size.y}`);
  assert.equal(Math.round(size.z), 40); // an in-plane turn can't change height

  // The same geometry through three's default: (200 + 40)·cos45 ≈ 169.7,
  // because both far corners of the box count even though no part is there.
  const loose = new THREE.Box3()
    .setFromObject(group)
    .getSize(new THREE.Vector3());
  assert.ok(loose.x > size.x + 10, `loose x was ${loose.x} vs ${size.x}`);
});

// The reported bug: FUS 2 of the Stallion fuselage, 296 x 128 mm turned ~46°,
// on a Bambu P1S's 256 mm plate. Bambu Studio slices it; the preview called it
// oversized because its rotated *box* spans ~300 mm.
test("a part that only fits diagonally is not flagged against that bed", () => {
  const size = measureBounds(diagonalTaperedPart(296.4, 128.4, 46)).getSize(
    new THREE.Vector3(),
  );
  assert.equal(exceedsBed(size, { x: 256, y: 256 }), false);
});

test("a genuinely too-big plate is still flagged, on either axis", () => {
  assert.equal(exceedsBed({ x: 300, y: 100 }, { x: 256, y: 256 }), true);
  assert.equal(exceedsBed({ x: 100, y: 300 }, { x: 256, y: 256 }), true);
  assert.equal(exceedsBed({ x: 100, y: 240 }, { x: 256, y: 210 }), true); // non-square bed
});

// The tolerance exists so a print sized to exactly fill the bed — or off by a
// float rounding error — doesn't warn; the slicer's own margins are wider.
test("a print that exactly fills the bed fits", () => {
  assert.equal(exceedsBed({ x: 256, y: 256 }, { x: 256, y: 256 }), false);
  assert.equal(exceedsBed({ x: 256.5, y: 256 }, { x: 256, y: 256 }), false);
  assert.equal(exceedsBed({ x: 258, y: 256 }, { x: 256, y: 256 }), true);
});

// "Auto" in the preview's plate picker draws a square sized to the geometry, so
// there is no real bed to overflow and nothing to warn about.
test("no known bed never warns", () => {
  assert.equal(exceedsBed({ x: 9999, y: 9999 }, null), false);
});
