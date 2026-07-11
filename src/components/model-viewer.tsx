"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import { Loader2, Maximize2, Minimize2, TriangleAlert } from "lucide-react";
import { parsePlateLayout } from "@/lib/threemf-plates";
import { cn } from "@/lib/utils";

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

export type ViewerFile = { filename: string; src: string };

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

// Guard against a giant project hanging the tab.
const MAX_BYTES = 50 * 1024 * 1024;

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
  const [fileIndex, setFileIndex] = useState(0);
  const [plateIndex, setPlateIndex] = useState(0);
  const [plateNames, setPlateNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Expand the viewport to a full-screen overlay, like the image lightbox. The
  // renderer follows the container via the existing ResizeObserver.
  const [fullscreen, setFullscreen] = useState(false);

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

    // Build-plate grid sized to the plate's footprint (10 mm cells, min 100 mm).
    const footprint = Math.max(size.x, size.z);
    const bedSize = Math.max(100, Math.ceil((footprint * 1.25) / 20) * 20);
    disposeObject(r.bed);
    r.bed.clear();
    const grid = new THREE.GridHelper(
      bedSize,
      Math.round(bedSize / 10),
      GRID_COLOR,
      GRID_COLOR,
    );
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(bedSize, bedSize),
      new THREE.MeshStandardMaterial({
        color: GRID_COLOR,
        transparent: true,
        opacity: 0.12,
        roughness: 1,
        side: THREE.DoubleSide,
      }),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = -0.05; // just under the grid to avoid z-fighting
    r.bed.add(plane, grid);

    const radius = Math.max(size.length() / 2, 10);
    r.camera.position.set(
      center.x + radius * 1.6,
      center.y + radius * 1.4,
      center.z + radius * 2.0,
    );
    r.controls.target.set(center.x, center.y, center.z);
    r.controls.update();
    r.frame();
  }, []);

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

  const multiFile = files.length > 1;
  const multiPlate = plateNames.length > 1;

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
      </div>

      {/* Plate selector, mirroring MakerWorld's per-plate rail. */}
      {multiPlate && !loading && !error && (
        <div className="absolute bottom-2 left-2 top-12 z-10 flex w-28 flex-col gap-1 overflow-y-auto rounded-lg bg-background/70 p-1 shadow-sm backdrop-blur">
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
