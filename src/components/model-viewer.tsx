"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import {
  ChevronDown,
  Loader2,
  Maximize2,
  Minimize2,
  TriangleAlert,
} from "lucide-react";
import { parsePlateLayout } from "@/lib/threemf-plates";
import {
  BED_PRESET_GROUPS,
  bedForChoice,
  defaultBedChoice,
} from "@/lib/printer-beds";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// In-browser 3D preview of stored .3mf files, built on the same on-demand
// three.js pattern as the parametric customizer's <ScadPreview>: the scene is
// static between interactions, so it renders on orbit/resize/selection change
// rather than a rAF loop (keeps laptops cool). Each .3mf ships as one zip
// through the tokened /api/files route, so we fetch + parse it entirely
// client-side — consistent with how .3mf import already works — and fall back
// to the model's thumbnail images (via onError) if it can't be rendered.
//
// Multi-plate Bambu projects place every plate's objects across one huge
// virtual bed; we split them back into per-plate groups (see threemf-plates.ts)
// and show one plate at a time, like MakerWorld.

export type ViewerFile = {
  filename: string;
  src: string;
  // Physical build-plate size in mm from the file's embedded slicer config
  // (PrinterInfo.bedSizeMm, issue #80). When present the preview draws a real
  // bed instead of a square sized to the geometry, giving a "will it fit"
  // reference; absent for files with no printer info.
  bed?: { x: number; y: number } | null;
};

type Plate = { name: string; group: THREE.Group };

type SceneRefs = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  root: THREE.Group; // holds the plate groups (Z-up → Y-up rotation)
  bed: THREE.Group; // world-space build-plate grid, resized per plate
  frame: () => void;
};

const MODEL_COLOR = 0xd9d9de;
const GRID_COLOR = 0x8b8f96;
// Bed grid tint when the geometry overflows the real plate (issue #80).
const GRID_WARN_COLOR = 0xdc2626;

// Guard against a giant project hanging the tab.
const MAX_BYTES = 50 * 1024 * 1024;

// Plate-name rail width (px). Draggable like the OpenSCAD customizer's parameter
// panel, clamped so a long plate name stays readable without swallowing the
// preview. Persisted so the choice sticks across files and page loads.
const RAIL_DEFAULT_WIDTH = 112; // matches the previous fixed w-28 (7rem)
const RAIL_MIN_WIDTH = 80;
const RAIL_MAX_WIDTH = 320;
const RAIL_WIDTH_KEY = "model-viewer-plate-rail-width";

function clampRailWidth(width: number) {
  return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, width));
}

// Builds a build-plate grid of `bedX` × `bedZ` mm (world XZ) centred on the
// origin — a translucent plane plus grid lines at ~10 mm cells. Unlike
// THREE.GridHelper (square only) this handles rectangular beds like the Prusa
// MK-series 250×210, so the drawn plate matches the printer's real dimensions.
function makeBedGrid(bedX: number, bedZ: number, color: number) {
  const group = new THREE.Group();
  const halfX = bedX / 2;
  const halfZ = bedZ / 2;
  // ~10 mm cells, coarser on big beds so the line count stays modest. Even
  // division keeps both outer edges on a line regardless of the bed size.
  const target = Math.max(bedX, bedZ) > 400 ? 20 : 10;
  const divX = Math.max(1, Math.round(bedX / target));
  const divZ = Math.max(1, Math.round(bedZ / target));
  const positions: number[] = [];
  for (let i = 0; i <= divX; i++) {
    const x = -halfX + (bedX * i) / divX;
    positions.push(x, 0, -halfZ, x, 0, halfZ);
  }
  for (let j = 0; j <= divZ; j++) {
    const z = -halfZ + (bedZ * j) / divZ;
    positions.push(-halfX, 0, z, halfX, 0, z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  const grid = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 }),
  );
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(bedX, bedZ),
    new THREE.MeshStandardMaterial({
      color,
      transparent: true,
      opacity: 0.12,
      roughness: 1,
      side: THREE.DoubleSide,
    }),
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -0.05; // just under the grid to avoid z-fighting
  group.add(plane, grid);
  return group;
}

// Frees GPU resources for any renderable (Mesh, GridHelper/LineSegments, …).
function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const geometry = (child as Partial<THREE.Mesh>).geometry;
    const material = (child as Partial<THREE.Mesh>).material;
    geometry?.dispose();
    if (material) {
      (Array.isArray(material) ? material : [material]).forEach((m) =>
        m.dispose(),
      );
    }
  });
}

export function ModelViewer({
  files,
  onError,
}: {
  // Every previewable .3mf on the model (tokened fileSrc URLs).
  files: ViewerFile[];
  // Called if a file can't be fetched/parsed, so the parent can fall back to
  // the thumbnail gallery.
  onError?: () => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const refs = useRef<SceneRefs | null>(null);
  const platesRef = useRef<Plate[]>([]);
  // Real bed size (mm) of the selected file, set on load and read by showPlate
  // (kept on a ref so showPlate stays dependency-free like platesRef).
  const bedRef = useRef<{ x: number; y: number } | null>(null);
  const [fileIndex, setFileIndex] = useState(0);
  const [plateIndex, setPlateIndex] = useState(0);
  const [plateNames, setPlateNames] = useState<string[]>([]);
  // Which build plate the picker is showing: "file" (the config's own bed,
  // the default), "auto" (footprint square), or a BED_PRESETS id. Mirrored on a
  // ref so showPlate can read it without re-running the load effect.
  const [bedChoice, setBedChoice] = useState(() =>
    defaultBedChoice(files[0]?.bed ?? null),
  );
  const bedChoiceRef = useRef(bedChoice);
  // Tracks which file the picker was last reset for, so switching files snaps
  // the picker back to that file's own bed (see the render-time reset below).
  const [choiceForFile, setChoiceForFile] = useState(fileIndex);
  // Whether the geometry overflows the currently drawn real plate — drives the
  // picker's warning styling. Always false for the footprint-square fallback.
  const [oversized, setOversized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Expand the viewport to a full-screen overlay, like the image lightbox. The
  // renderer follows the container via the existing ResizeObserver.
  const [fullscreen, setFullscreen] = useState(false);
  // Drag-resizable plate-name rail (mirrors the customizer's parameter panel).
  const railRef = useRef<HTMLDivElement>(null);
  const [railWidth, setRailWidth] = useState(RAIL_DEFAULT_WIDTH);
  const resizingRail = useRef(false);

  // Reveal one plate, size the bed to it, and frame the camera. Kept on a ref
  // so the plate buttons can call it without re-running the load effect.
  const showPlate = useCallback((index: number) => {
    const r = refs.current;
    const plates = platesRef.current;
    const plate = plates[index];
    if (!r || !plate) return;

    plates.forEach((p, i) => (p.group.visible = i === index));

    const box = new THREE.Box3().setFromObject(plate.group);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    // Draw the file's real bed when we know it (.3mf X→world X, Y→world Z), so
    // the plate is a true size reference; otherwise fall back to a square just
    // larger than the plate's footprint (10 mm cells, min 100 mm).
    const realBed = bedForChoice(bedChoiceRef.current, bedRef.current);
    // A small tolerance keeps a print that exactly fills the bed from tripping
    // the overflow flag.
    const isOversized =
      !!realBed && (size.x > realBed.x + 1 || size.z > realBed.y + 1);
    let bedX: number;
    let bedZ: number;
    if (realBed) {
      bedX = realBed.x;
      bedZ = realBed.y;
    } else {
      const footprint = Math.max(size.x, size.z);
      bedX = bedZ = Math.max(100, Math.ceil((footprint * 1.25) / 20) * 20);
    }
    setOversized(isOversized);

    disposeObject(r.bed);
    r.bed.clear();
    r.bed.add(
      makeBedGrid(bedX, bedZ, isOversized ? GRID_WARN_COLOR : GRID_COLOR),
    );

    // Frame the whole bed, not just the geometry, so a small print reads as
    // small on a large plate (the point of the real-bed reference).
    const radius = Math.max(size.length() / 2, Math.hypot(bedX, bedZ) / 2, 10);
    r.camera.position.set(
      center.x + radius * 1.6,
      center.y + radius * 1.4,
      center.z + radius * 2.0,
    );
    r.controls.target.set(center.x, center.y, center.z);
    r.controls.update();
    r.frame();
  }, []);

  // Mirror the picked plate onto a ref so the dependency-free showPlate can read
  // it (the same pattern as bedRef/platesRef). The onChange handler also sets
  // this synchronously so its own showPlate call sees the new plate immediately.
  useEffect(() => {
    bedChoiceRef.current = bedChoice;
  }, [bedChoice]);

  // Scene lifecycle: created once on mount, torn down on unmount.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      40,
      mount.clientWidth / mount.clientHeight,
      0.1,
      100_000,
    );
    camera.position.set(120, 110, 140);

    // Soft studio-ish light: sky/ground fill plus one key light, matching how
    // slicers present a matte print on the plate.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(180, 320, 220);
    scene.add(key);

    // Plates live under a rotated root (.3mf is Z-up, three.js is Y-up); the
    // bed lives in world space since plates are recentered onto the origin.
    const root = new THREE.Group();
    root.rotation.set(-Math.PI / 2, 0, 0);
    scene.add(root);
    const bed = new THREE.Group();
    scene.add(bed);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.maxPolarAngle = Math.PI * 0.55; // don't dive far below the plate
    const frame = () => renderer.render(scene, camera);
    controls.addEventListener("change", frame);

    const observer = new ResizeObserver(() => {
      const { clientWidth, clientHeight } = mount;
      if (clientWidth === 0 || clientHeight === 0) return;
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(clientWidth, clientHeight);
      frame();
    });
    observer.observe(mount);

    refs.current = { renderer, scene, camera, controls, root, bed, frame };
    frame();

    return () => {
      observer.disconnect();
      controls.dispose();
      disposeObject(scene);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      refs.current = null;
      platesRef.current = [];
    };
  }, []);

  // Load the selected file: fetch, parse geometry + plate layout, and rebuild
  // the plate groups.
  useEffect(() => {
    const file = files[fileIndex];
    if (!file) return;
    bedRef.current = file.bed ?? null;
    const controller = new AbortController();
    let disposed = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(file.src, { signal: controller.signal });
        if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
        const length = Number(res.headers.get("content-length"));
        if (length && length > MAX_BYTES) {
          throw new Error("This model is too large to preview in the browser.");
        }
        const buffer = await res.arrayBuffer();
        if (disposed) return;
        if (buffer.byteLength > MAX_BYTES) {
          throw new Error("This model is too large to preview in the browser.");
        }

        const bytes = new Uint8Array(buffer);
        const object = new ThreeMFLoader().parse(buffer);
        const layout = parsePlateLayout(bytes);
        const r = refs.current;
        if (disposed || !r) return;

        // Give every mesh the same matte look as the customizer preview,
        // regardless of the file's embedded materials/colors.
        object.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            const mat = child.material as THREE.Material | THREE.Material[];
            (Array.isArray(mat) ? mat : [mat]).forEach((m) => m.dispose());
            child.material = new THREE.MeshStandardMaterial({
              color: MODEL_COLOR,
              roughness: 0.55,
              metalness: 0.05,
            });
          }
        });

        // Split the build items (top-level children, in build order) into plate
        // buckets. Without a layout, everything is one plate.
        const buildItems = [...object.children];
        if (buildItems.length === 0) {
          throw new Error("The file contained no geometry.");
        }
        const names = layout?.plateNames ?? ["Model"];
        const buckets: THREE.Object3D[][] = names.map(() => []);
        buildItems.forEach((child, i) => {
          const p = layout ? layout.plateOfBuildItem[i] : 0;
          // Unclaimed objects (-1) ride along on the first plate.
          buckets[p >= 0 ? p : 0].push(child);
        });

        // Clear any previously loaded plates.
        r.root.clear();
        platesRef.current.forEach((p) => disposeObject(p.group));

        const plates: Plate[] = [];
        buckets.forEach((children, i) => {
          if (children.length === 0) return;
          const group = new THREE.Group();
          children.forEach((c) => group.add(c)); // reparent (build transforms kept)
          // Recenter in the .3mf's Z-up space: center on the bed (XY) and drop
          // the lowest point to Z=0 so it rests on the plate.
          const box = new THREE.Box3().setFromObject(group);
          const center = box.getCenter(new THREE.Vector3());
          group.position.set(-center.x, -center.y, -box.min.z);
          group.visible = false;
          r.root.add(group);
          plates.push({ name: names[i], group });
        });
        if (plates.length === 0) throw new Error("The file contained no geometry.");

        platesRef.current = plates;
        setPlateNames(plates.map((p) => p.name));
        setPlateIndex(0);
        showPlate(0);
        setLoading(false);
      } catch (err) {
        if (disposed || controller.signal.aborted) return;
        setLoading(false);
        setError(
          err instanceof Error ? err.message : "Couldn't render this model.",
        );
        onError?.();
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileIndex, files]);

  // Escape leaves full screen, matching the image lightbox.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // Restore the last dragged rail width once mounted (avoids SSR/localStorage skew).
  useEffect(() => {
    const stored = Number(window.localStorage.getItem(RAIL_WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) setRailWidth(clampRailWidth(stored));
  }, []);

  const startRailResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    resizingRail.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!resizingRail.current || !railRef.current) return;
      const left = railRef.current.getBoundingClientRect().left;
      setRailWidth(clampRailWidth(e.clientX - left));
    }
    function onUp() {
      if (!resizingRail.current) return;
      resizingRail.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.localStorage.setItem(RAIL_WIDTH_KEY, String(railWidth));
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [railWidth]);

  // Switching files snaps the picker back to that file's own bed — a preset
  // picked for the last file shouldn't carry over to one sliced for a different
  // printer. Done during render (React's "adjust state on prop change" pattern)
  // rather than in an effect. bedChoiceRef follows via its sync effect, which
  // lands well before the load effect's async showPlate reads it.
  if (choiceForFile !== fileIndex) {
    setChoiceForFile(fileIndex);
    setBedChoice(defaultBedChoice(files[fileIndex]?.bed ?? null));
  }

  const multiFile = files.length > 1;
  const multiPlate = plateNames.length > 1;
  const fileBed = files[fileIndex]?.bed ?? null;

  return (
    <div
      className={cn(
        fullscreen ? "fixed inset-0 z-50 bg-background" : "absolute inset-0 bg-muted/30",
      )}
    >
      <div ref={mountRef} className="absolute inset-0" />

      {/* File switcher + full-screen toggle, top-right (top-left holds the
          platform badge, top-center the Photos/3D toggle). */}
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1.5">
        {multiFile && (
          <select
            value={fileIndex}
            onChange={(e) => setFileIndex(Number(e.target.value))}
            className="w-32 min-w-0 truncate rounded-md border bg-background/90 px-2 py-1 text-xs shadow-sm backdrop-blur focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:w-44"
            aria-label="Choose a file to preview"
          >
            {files.map((f, i) => (
              <option key={f.src} value={i}>
                {f.filename}
              </option>
            ))}
          </select>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setFullscreen((v) => !v)}
              className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background/90 shadow-sm backdrop-blur hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              aria-label={fullscreen ? "Exit full screen" : "View full screen"}
            >
              {fullscreen ? (
                <Minimize2 className="size-4" />
              ) : (
                <Maximize2 className="size-4" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {fullscreen ? "Exit full screen" : "View full screen"}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Plate selector, mirroring MakerWorld's per-plate rail. Drag its right
          edge to widen it for long plate names (like the customizer panel). */}
      {multiPlate && !loading && !error && (
        <div
          ref={railRef}
          style={{ "--rail-width": `${railWidth}px` } as React.CSSProperties}
          className="absolute bottom-2 left-2 top-12 z-10 flex w-[var(--rail-width)] flex-col rounded-lg bg-background/70 shadow-sm backdrop-blur"
        >
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1">
            <div className="sticky top-0 z-10 rounded-t-md bg-background/80 px-2 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
              Plates
            </div>
            {plateNames.map((name, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setPlateIndex(i);
                  showPlate(i);
                }}
                className={cn(
                  "shrink-0 truncate rounded-md px-2 py-1.5 text-left text-xs font-medium transition-colors",
                  i === plateIndex
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
                title={name}
              >
                {name}
              </button>
            ))}
          </div>

          {/* Drag to resize the rail width. */}
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={startRailResize}
            className="group/rail absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none"
          >
            <div className="mx-auto h-full w-1 rounded-full bg-transparent transition-colors group-hover/rail:bg-primary/80" />
          </div>
        </div>
      )}

      {/* Build-plate picker + size reference (issue #80): defaults to the plate
          the file was sliced for, and lets you check the model against another
          common bed. Turns red and warns when the geometry overflows it. */}
      {!loading && !error && (
        <div className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2">
          <div
            title={oversized ? "Model is larger than this plate" : undefined}
            className={cn(
              "flex items-center gap-1 rounded-full py-1 pl-2.5 pr-1.5 text-xs font-medium shadow-sm backdrop-blur",
              oversized
                ? "bg-destructive/90 text-destructive-foreground"
                : "bg-background/80 text-muted-foreground",
            )}
          >
            {oversized && <TriangleAlert className="size-3.5 shrink-0" />}
            <div className="relative flex items-center">
              <select
                value={bedChoice}
                onChange={(e) => {
                  const value = e.target.value;
                  bedChoiceRef.current = value;
                  setBedChoice(value);
                  showPlate(plateIndex);
                }}
                aria-label="Build plate size"
                className="max-w-[min(60vw,16rem)] cursor-pointer appearance-none truncate rounded-full bg-transparent py-0.5 pr-5 tabular-nums focus-visible:outline-none"
              >
                {fileBed && (
                  <option value="file">
                    From file — {fileBed.x} × {fileBed.y} mm
                  </option>
                )}
                <option value="auto">Fit to model</option>
                {BED_PRESET_GROUPS.map(([group, presets]) => (
                  <optgroup key={group} label={group}>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label} — {p.x} × {p.y} mm
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1 size-3.5 opacity-70" />
            </div>
          </div>
        </div>
      )}

      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex items-center gap-2 rounded-lg border bg-background/90 px-4 py-2.5 text-sm shadow-sm">
            <Loader2 className="size-4 animate-spin" />
            Loading 3D preview…
          </div>
        </div>
      )}
      {error && (
        <div className="absolute inset-x-0 bottom-4 flex justify-center px-4">
          <div className="flex max-w-md items-start gap-2 rounded-lg border border-destructive/40 bg-background/95 px-4 py-2.5 text-sm shadow-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        </div>
      )}
    </div>
  );
}
