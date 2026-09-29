// Measuring a build plate's footprint and deciding whether it fits a bed — the
// pure core behind the 3D preview's "Model is larger than this plate" warning
// (issue #80). Lives outside <ModelViewer> so the rule can be unit-tested
// against real geometry without a WebGL context.

import * as THREE from "three";

// A plate's extents in the .3mf's own Z-up space: X/Y are the bed axes, Z is
// height.
export type PlateSize = { x: number; y: number };

// Measures an object's true axis-aligned extents from its vertex data.
//
// The `precise` flag is the whole point: three's default Box3.setFromObject
// unions each mesh's *bounding box transformed by its world matrix*, i.e. the
// box around a rotated box. For a part laid diagonally on the plate — which is
// exactly how a slicer fits a long part onto a square bed — that over-states
// the footprint badly: a 296 x 128 mm fuselage turned 45 degrees really covers
// 219 x 223 mm, but its rotated bounding box spans 299 x 302 mm and reads as
// too big for a 256 mm bed the slicer prints it on happily.
export function measureBounds(object: THREE.Object3D): THREE.Box3 {
  return new THREE.Box3().setFromObject(object, true);
}

// Whether a plate overflows `bed` (mm). Null bed — the viewer's footprint-sized
// square fallback — can never overflow. The 1 mm tolerance keeps a print that
// exactly fills the bed, or misses by a rounding error, from tripping the
// warning; the real slicer's own margins are wider than that.
export function exceedsBed(
  size: PlateSize,
  bed: PlateSize | null,
): boolean {
  if (!bed) return false;
  return size.x > bed.x + 1 || size.y > bed.y + 1;
}
