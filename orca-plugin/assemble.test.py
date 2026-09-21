#!/usr/bin/env python3
"""Tests for the project merge in orca_print_vault_plugin_any.py.

Run directly: `python3 orca-plugin/assemble.test.py` (stdlib only, no slicer
and no instance involved). CI runs it alongside `npm test`.

The merge is the riskiest logic in slice-push: it takes OrcaSlicer's live
project checkpoint, which has no meshes, and the file the project was saved to,
which has them under a *different* object numbering, and has to produce a
project any reader can open. Two versions of it shipped files that OrcaSlicer
itself had written every part of and that nothing else could open:

1. the component references pointed at object ids no part defined, so
   PrusaSlicer answered "Loading of a model file failed";
2. then the ids were mapped to the saved file's numbering — which collided
   with the model's own wrapper objects. three.js keys objects by id in one
   namespace for the whole archive, so the wrappers shadowed the meshes and the
   3D preview rendered an empty scene. Rewriting the model also broke
   `model_settings.config`, which keys per-part settings on those same ids.

So the fixtures reproduce the whole shape: save-time numbering that overlaps
the live numbering, a deduped mesh stored once with the duplicate's part
written empty, per-part settings keyed on the live ids, an object deleted in
the slicer, and one whose mesh was edited there.
"""

import importlib.util
import os
import hashlib
import re
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "pv", os.path.join(HERE, "orca_print_vault_plugin_any.py")
)
pv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pv)

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>"""

ROOT_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"""

MESH = """<mesh>
    <vertices>
     <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>
     <vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>
    </vertices>
    <triangles>
     <triangle v1="0" v2="1" v3="2"/><triangle v1="0" v2="1" v3="3"/>
    </triangles>
   </mesh>"""


def part(objects: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <resources>
{objects}
 </resources>
 <build/>
</model>"""


def mesh_part(object_id: int) -> str:
    return part(f'  <object id="{object_id}" type="model">\n   {MESH}\n  </object>')


def model(objects: str, items: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <resources>
{objects}
 </resources>
 <build>
{items}
 </build>
</model>"""


def wrapper(object_id: int, uuid: str, component_uuid: str, path: str, target: int) -> str:
    return (
        f'  <object id="{object_id}" p:UUID="{uuid}" type="model">\n'
        f"   <components>\n"
        f'    <component p:path="{path}" objectid="{target}" p:UUID="{component_uuid}" '
        f'transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n'
        f"   </components>\n"
        f"  </object>"
    )


def rels(targets) -> str:
    lines = "\n".join(
        f' <Relationship Target="{t}" Id="rel-{i}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
        for i, t in enumerate(targets, start=1)
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        f"{lines}\n</Relationships>"
    )


# Component UUIDs: the only identity that survives a save (object ids do not,
# and the part a component points at may change when meshes are deduped).
CUBE_A, CUBE_B, CONE, ADDED = "c0-a", "c0-b", "c0-c", "c0-n"

# Save-time object ids, chosen the way OrcaSlicer's allocator does it: from the
# same small sequence the model's own wrappers come from. So they *overlap* the
# live wrapper ids below (11, 12), which is what made the second attempt at
# this ship an empty 3D preview.
ORIGIN_MODEL = model(
    objects="\n".join(
        [
            # Both cube objects point at ONE part: an identical mesh is stored
            # once, and the duplicate's part is written empty.
            wrapper(2, "obj-a", CUBE_A, "/3D/Objects/Cube.STL_10.model", 11),
            wrapper(4, "obj-b", CUBE_B, "/3D/Objects/Cube.STL_10.model", 11),
            wrapper(6, "obj-c", CONE, "/3D/Objects/Cone.STL_12.model", 12),
            wrapper(8, "obj-d", "c0-gone", "/3D/Objects/Gone.STL_13.model", 13),
        ]
    ),
    items="\n".join(
        f'  <item objectid="{oid}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>' for oid in (2, 4, 6, 8)
    ),
)

# The live project: its own numbering (65536 + n), one part named per object
# (including the deduped one, whose part the save left empty), a new object
# whose mesh only the checkpoint has, and the deleted object gone from both
# the resources and the build.
LIVE_MODEL = model(
    objects="\n".join(
        [
            wrapper(10, "obj-a", CUBE_A, "/3D/Objects/Cube.STL_10.model", 65546),
            wrapper(11, "obj-b", CUBE_B, "/3D/Objects/Cube.STL_11.model", 65547),
            wrapper(12, "obj-c", CONE, "/3D/Objects/Cone.STL_12.model", 65548),
            wrapper(20, "obj-n", ADDED, "/3D/Objects/New.STL_20.model", 65556),
        ]
    ),
    items="\n".join(
        f'  <item objectid="{oid}" transform="0 -1 0 1 0 0 0 0 1 {oid}0 5 0"/>'
        for oid in (10, 11, 12, 20)
    ),
)

ORIGIN_SETTINGS = (
    '{\n\t"curr_bed_type": "High Temp Plate",\n\t"layer_height": "0.2",\n'
    '\t"print_plugin_config_overrides": ""\n}'
)
# What OrcaSlicer actually keeps in the *print* config while the plugin is
# configured: the push token, in plaintext.
LIVE_SETTINGS = (
    '{\n\t"curr_bed_type": "Engineering Plate",\n\t"layer_height": "0.12",\n'
    '\t"different_settings_to_system": ["layer_height;plugins;slicing_pipeline_plugin"],\n'
    '\t"plugins": ["orca_print_vault_plugin_any;;Push sliced file to Print Vault"],\n'
    '\t"slicing_pipeline_plugin": ["Push sliced file to Print Vault"],\n'
    '\t"print_plugin_config_overrides": '
    '"[{\\"cap_config\\":{\\"token\\":\\"pvpush_SECRET\\",\\"url\\":\\"http://vault\\"}}]"\n}'
)

# Per-object and per-part settings — extruder assignment, painted supports,
# the part's own transform — keyed on the *model's* object ids and on the
# component object ids (`<part id>`). Rewriting either numbering without this
# file loses them silently, which is why the merge leaves both alone.
LIVE_MODEL_SETTINGS = """<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="10">
    <metadata key="extruder" value="2"/>
    <part id="65546" subtype="normal_part"><metadata key="name" value="Cube"/></part>
  </object>
  <object id="11">
    <metadata key="extruder" value="1"/>
    <part id="65547" subtype="normal_part"><metadata key="name" value="Cube copy"/></part>
  </object>
  <object id="12">
    <part id="65548" subtype="normal_part"><metadata key="name" value="Cone"/></part>
  </object>
  <object id="20">
    <part id="65556" subtype="normal_part"><metadata key="name" value="Added"/></part>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <model_instance><metadata key="object_id" value="10"/></model_instance>
  </plate>
</config>"""

SLICE_INFO = """<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="3600"/>
    <metadata key="weight" value="12.5"/>
  </plate>
</config>"""

GCODE = (
    "; HEADER_BLOCK_START\n"
    "; model printing time: 4h 53m 23s; total estimated time: 5h 0m 4s\n"
    "G1 X1 Y1 E1\n" * 3 + "; filament used [g] = 21.65, 0.00\n"
)


def build_fixture(root: str, *, break_reference: bool = False) -> tuple[str, dict]:
    origin = os.path.join(root, "Talon.3mf")
    with zipfile.ZipFile(origin, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", ROOT_RELS)
        z.writestr("3D/3dmodel.model", ORIGIN_MODEL)
        z.writestr(
            "3D/_rels/3dmodel.model.rels",
            rels(
                [
                    "/3D/Objects/Cube.STL_10.model",
                    "/3D/Objects/Cube.STL_11.model",
                    "/3D/Objects/Cone.STL_12.model",
                    "/3D/Objects/Gone.STL_13.model",
                ]
            ),
        )
        z.writestr("3D/Objects/Cube.STL_10.model", mesh_part(11))
        # The duplicate's part, written empty because the mesh is stored once.
        z.writestr("3D/Objects/Cube.STL_11.model", part(""))
        z.writestr("3D/Objects/Cone.STL_12.model", mesh_part(12))
        # The object deleted in the slicer: still here, no longer referenced.
        z.writestr("3D/Objects/Gone.STL_13.model", mesh_part(13))
        z.writestr("Metadata/project_settings.config", ORIGIN_SETTINGS)
        z.writestr("Metadata/model_settings.config", "<config>old</config>")
        z.writestr("Metadata/plate_1.png", b"\x89PNG stub")
        z.writestr("Auxiliaries/Assembly Guide/manual.pdf", b"%PDF-1.4 stub")

    checkpoint_dir = os.path.join(root, "13_35_21#4242#1")
    os.makedirs(os.path.join(checkpoint_dir, "3D", "Objects"))
    live = LIVE_MODEL
    if break_reference:
        # An object whose mesh is in neither file: the saved file has never
        # seen this component UUID, and the checkpoint has not written the
        # part out. Happens when the origin has been replaced by an unrelated
        # file, and must refuse rather than push a project missing an object.
        live = live.replace(
            wrapper(20, "obj-n", ADDED, "/3D/Objects/New.STL_20.model", 65556),
            wrapper(20, "obj-n", "c0-ghost", "/3D/Objects/Ghost.STL_42.model", 65599),
        )
    with zipfile.ZipFile(os.path.join(checkpoint_dir, ".3mf"), "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", ROOT_RELS)
        z.writestr("3D/3dmodel.model", live)
        z.writestr(
            "3D/_rels/3dmodel.model.rels",
            rels(
                [
                    "/3D/Objects/Cube.STL_10.model",
                    "/3D/Objects/Cube.STL_11.model",
                    "/3D/Objects/"
                    + ("Vanished.STL_99.model" if break_reference else "Cone.STL_12.model"),
                    "/3D/Objects/New.STL_20.model",
                ]
            ),
        )
        z.writestr("Metadata/project_settings.config", LIVE_SETTINGS)
        z.writestr("Metadata/model_settings.config", LIVE_MODEL_SETTINGS)
        z.writestr("Metadata/slice_info.config", SLICE_INFO)
    # A mesh added or edited in the slicer lives loose in the checkpoint.
    with open(os.path.join(checkpoint_dir, "3D", "Objects", "New.STL_20.model"), "w") as handle:
        handle.write(mesh_part(65556))
    with open(os.path.join(checkpoint_dir, "origin.txt"), "w") as handle:
        handle.write(origin)
    with open(os.path.join(checkpoint_dir, "lock.txt"), "w") as handle:
        handle.write("4242")
    return origin, pv.checkpoint_at(checkpoint_dir)


# --- what a reader has to be able to do with the result ---------------------


def objects_in(data: bytes) -> dict:
    return {
        m.group(1): m.group(2)
        for m in re.finditer(rb'<object id="(\d+)"[^>]*>(.*?)</object>', data, re.S)
    }


def unreachable_items(path: str) -> list:
    """Build items that reach no geometry — an empty scene in the 3D preview.

    Resolved the way three.js's 3MFLoader does it: **one id namespace for the
    whole archive**, `p:path` ignored (`buildObjects` merges every `.model`
    part into a single `objects` map). That is stricter than resolving by
    path + id, and it is the view that matters — PrusaSlicer resolves by path,
    so a file can slice perfectly and still render nothing.
    """
    objects: dict = {}
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if name.endswith(".model"):
                objects.update(objects_in(z.read(name)))
        items = re.findall(rb'<item[^>]*?objectid="(\d+)"', z.read("3D/3dmodel.model"))

    def reaches(object_id: bytes, depth: int = 0) -> bool:
        body = objects.get(object_id)
        if body is None or depth > 4:
            return False
        if b"<mesh>" in body:
            return True
        return any(
            reaches(target, depth + 1)
            for target in re.findall(rb'<component\b[^>]*?objectid="(\d+)"', body)
        )

    return [i.decode() for i in items if not reaches(i)]


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {name}")
        return
    print(f"  FAIL {name}{(' — ' + detail) if detail else ''}")
    check.failed = True


check.failed = False


def main() -> int:
    with tempfile.TemporaryDirectory() as root:
        origin, checkpoint = build_fixture(root)
        out = os.path.join(root, "synced.3mf")
        pv.assemble_project(origin, checkpoint, out)

        with zipfile.ZipFile(out) as z:
            all_names = z.namelist()
            names = set(all_names)
            model_xml = z.read("3D/3dmodel.model")
            model_settings = z.read("Metadata/model_settings.config")
            settings = z.read("Metadata/project_settings.config").decode()
            parts = {
                n: [i.decode() for i in objects_in(z.read(n))]
                for n in names
                if n.startswith("3D/Objects/")
            }
            refs = [
                (
                    re.search(rb'p:path="([^"]+)"', m.group(0)).group(1).lstrip(b"/").decode(),
                    re.search(rb'objectid="(\d+)"', m.group(0)).group(1).decode(),
                )
                for m in re.finditer(rb"<component\b[^>]*?>", model_xml)
            ]
            claimed: dict = {}
            for name in all_names:
                if name.endswith(".model"):
                    for oid in objects_in(z.read(name)):
                        claimed.setdefault(oid.decode(), []).append(name)

        print("a merged project is loadable by something other than OrcaSlicer:")
        check("every build item reaches real geometry", unreachable_items(out) == [],
              f"unreachable: {unreachable_items(out)}")
        # The regression: a saved file numbers its mesh objects from the same
        # small sequence as the model's wrapper objects, so carrying those ids
        # over makes two different objects share one — and in a single id
        # namespace one wins while the other silently loses its geometry.
        check("no object id is claimed twice in the package",
              not [k for k, v in claimed.items() if len(v) > 1],
              str({k: v for k, v in claimed.items() if len(v) > 1}))
        check("every component reference resolves",
              all(oid in parts.get(path, []) for path, oid in refs), str(refs))
        # The checkpoint asks for object 65547 from a part the save left empty;
        # only the component UUID says that means the mesh stored once as
        # Cube.STL_10.model. Both copies end up with geometry of their own.
        check("a deduped duplicate gets a part of its own",
              parts.get("3D/Objects/Cube.STL_11.model") == ["65547"], str(parts))

        print("\nthe checkpoint's own numbering is left alone:")
        with zipfile.ZipFile(checkpoint["project"]) as live:
            check("the model is the checkpoint's, byte for byte",
                  model_xml == live.read("3D/3dmodel.model"))
            check("model_settings is the checkpoint's, byte for byte",
                  model_settings == live.read("Metadata/model_settings.config"))
        part_ids = set(re.findall(rb'<part id="(\d+)"', model_settings))
        defined = {oid.encode() for ids in parts.values() for oid in ids}
        check("every per-part setting still points at an object that exists",
              part_ids <= defined,
              f"dangling: {sorted(i.decode() for i in part_ids - defined)}")

        print("\nwhat the user changed is what lands:")
        check("the layout is the checkpoint's", b'transform="0 -1 0 1 0 0 0 0 1 100 5 0"' in model_xml)
        check("the settings are the checkpoint's", '"curr_bed_type": "Engineering Plate"' in settings)
        check("the slice predictions come along", "Metadata/slice_info.config" in names)
        check("a mesh edited or added in the slicer comes along", "3D/Objects/New.STL_20.model" in names)
        check("meshes the project no longer references are dropped",
              "3D/Objects/Gone.STL_13.model" not in names)
        check("the project's own files survive", "Auxiliaries/Assembly Guide/manual.pdf" in names)

        print("\nthe push token never travels in a project file:")
        check("no token in the settings", "pvpush_SECRET" not in settings)
        check("no token anywhere in the archive", b"pvpush_SECRET" not in open(out, "rb").read())
        check("the plugin is not left enabled for whoever opens it",
              '"slicing_pipeline_plugin": []' in settings and '"plugins": []' in settings)
        check("the plugin keys leave different_settings_to_system",
              "plugins" not in settings.split('"different_settings_to_system": [')[1].split("]")[0])

        print("\nthe sliced G-code, folded in rather than uploaded beside it:")
        gcode_path = os.path.join(root, "plate.gcode")
        with open(gcode_path, "w") as handle:
            handle.write(GCODE)
        bundle = os.path.join(root, "bundle.3mf")
        pv.assemble_project(origin, checkpoint, bundle, gcode_by_plate={1: gcode_path})
        with zipfile.ZipFile(bundle) as z:
            bundle_names = set(z.namelist())
            md5 = z.read("Metadata/plate_1.gcode.md5").decode()
            types = z.read("[Content_Types].xml").decode()
        check("the plate's G-code is inside the project", "Metadata/plate_1.gcode" in bundle_names)
        check("with the checksum sidecar Bambu's own bundle carries",
              md5 == hashlib.md5(GCODE.encode()).hexdigest().upper())
        check("and a content type that lets it be there", 'Extension="gcode"' in types)
        check("the bundle is still loadable", unreachable_items(bundle) == [])

        print("\na project that cannot be merged is refused, not pushed:")
        broken_root = os.path.join(root, "broken")
        os.makedirs(broken_root)
        broken_origin, broken_checkpoint = build_fixture(broken_root, break_reference=True)
        try:
            pv.assemble_project(
                broken_origin, broken_checkpoint, os.path.join(root, "bad.3mf")
            )
            check("a mesh neither file has raises", False, "it was accepted")
        except pv.VaultError as exc:
            check("a mesh neither file has raises", True)
            check("and says what is missing", "Ghost" in str(exc), str(exc))

        print("\nthe estimate that travels with a sync:")
        stats = pv.parse_gcode_stats(gcode_path)
        # Bambu/Orca write the print time in the *header*, both times on one
        # line; taking the line whole would report 9 h 53 for a 5 h print.
        check("the total estimate is read from the header",
              stats.get("printTimeSeconds") == 18004, str(stats))
        check("filament comes from the footer", stats.get("filamentGrams") == 21.65, str(stats))
        check("plates are summed, and a re-fired plate is not counted twice",
              pv.sum_plate_stats({"1": {"printTimeSeconds": 10, "filamentGrams": 1.5},
                                  "2": {"printTimeSeconds": 20, "filamentGrams": 2.5}})
              == {"printTimeSeconds": 30, "filamentGrams": 4.0})

    print("\nfailed" if check.failed else "\nall checks passed")
    return 1 if check.failed else 0


if __name__ == "__main__":
    sys.exit(main())
