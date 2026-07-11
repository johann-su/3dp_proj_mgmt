import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { parsePlateLayout } from "@/lib/threemf-plates";

// Minimal Bambu-shaped .3mf: a <build> whose item order maps to scene-child
// order, and model_settings plates that claim objects by id.
function make3mf(model: string, settings: string): Uint8Array {
  return zipSync({
    "3D/3dmodel.model": strToU8(model),
    "Metadata/model_settings.config": strToU8(settings),
  });
}

test("parsePlateLayout maps build items to the plate that claims them", () => {
  // Build order: objects 10, 20, 30. Plate 1 has {10,30}, plate 2 has {20}.
  const model = `<model><build>
    <item objectid="10" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
    <item objectid="20" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
    <item objectid="30" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
  </build></model>`;
  const settings = `<config>
    <plate>
      <metadata key="plater_name" value="First"/>
      <model_instance><metadata key="object_id" value="10"/></model_instance>
      <model_instance><metadata key="object_id" value="30"/></model_instance>
    </plate>
    <plate>
      <model_instance><metadata key="object_id" value="20"/></model_instance>
    </plate>
  </config>`;

  const layout = parsePlateLayout(make3mf(model, settings));
  assert.ok(layout);
  // build order [10,20,30] → plate indices [0,1,0]
  assert.deepEqual(layout.plateOfBuildItem, [0, 1, 0]);
  // named plate keeps its name; unnamed falls back to "Plate N"
  assert.deepEqual(layout.plateNames, ["First", "Plate 2"]);
});

test("parsePlateLayout returns null for a single-plate file (no selector needed)", () => {
  const model = `<model><build><item objectid="1"/></build></model>`;
  const settings = `<config><plate><model_instance><metadata key="object_id" value="1"/></model_instance></plate></config>`;
  assert.equal(parsePlateLayout(make3mf(model, settings)), null);
});

test("parsePlateLayout returns null when ids don't correlate — falls back to whole model", () => {
  // Plates reference ids that never appear as build items.
  const model = `<model><build><item objectid="1"/><item objectid="2"/></build></model>`;
  const settings = `<config>
    <plate><model_instance><metadata key="object_id" value="99"/></model_instance></plate>
    <plate><model_instance><metadata key="object_id" value="98"/></model_instance></plate>
  </config>`;
  assert.equal(parsePlateLayout(make3mf(model, settings)), null);
});
