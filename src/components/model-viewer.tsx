"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import { Loader2, TriangleAlert } from "lucide-react";

// In-browser 3D preview of a stored .3mf, built on the same on-demand three.js
// pattern as the parametric customizer's <ScadPreview>: the scene is static
// between interactions, so it renders on orbit/resize/geometry change rather
// than a rAF loop (keeps laptops cool). The .3mf ships as one zip through the
// tokened /api/files route, so we fetch + parse it entirely client-side —
// consistent with how .3mf import already works — and fall back to the model's
// thumbnail images (via onError) if parsing or rendering fails.
type SceneRefs = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  frame: () => void;
};

const MODEL_COLOR = 0xd9d9de;
const GRID_COLOR = 0x8b8f96;

// Guard against a giant project hanging the tab: a .3mf zip past this size is
// almost always a huge multi-plate export, not something worth previewing.
const MAX_BYTES = 50 * 1024 * 1024;

export function ModelViewer({
  src,
  onError,
}: {
  // Tokened /api/files URL of the .3mf (fileSrc(id)).
  src: string;
  // Called once if the file can't be fetched/parsed, so the parent can fall
  // back to the thumbnail gallery.
  onError?: () => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const refs = useRef<SceneRefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

    refs.current = { renderer, scene, camera, controls, frame };
    frame();

    return () => {
      observer.disconnect();
      controls.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const mat = obj.material as THREE.Material | THREE.Material[];
          (Array.isArray(mat) ? mat : [mat]).forEach((m) => m.dispose());
        }
      });
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      refs.current = null;
    };
  }, []);

  // Fetch + parse the .3mf, then add its geometry to the scene. A parse failure
  // (unsupported/corrupt file) surfaces to the parent as a fallback.
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    (async () => {
      try {
        const res = await fetch(src, { signal: controller.signal });
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

        const object = new ThreeMFLoader().parse(buffer);
        const r = refs.current;
        if (disposed || !r) return;

        // 3MF is Z-up; three.js is Y-up. Stand the build on the plate.
        object.rotation.set(-Math.PI / 2, 0, 0);
        object.updateMatrixWorld(true);

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

        // Recenter on the origin and drop onto the plate — multi-plate Bambu
        // projects place objects far from origin, so this frames them together.
        const box = new THREE.Box3().setFromObject(object);
        if (box.isEmpty()) throw new Error("The file contained no geometry.");
        const center = box.getCenter(new THREE.Vector3());
        object.position.set(-center.x, -box.min.y, -center.z);
        object.updateMatrixWorld(true);

        r.scene.add(object);

        // Build-plate grid sized to the part (10 mm cells, min 100 mm).
        const size = box.getSize(new THREE.Vector3());
        const gridSize = Math.max(
          100,
          Math.ceil((Math.max(size.x, size.z) * 1.8) / 20) * 20,
        );
        const grid = new THREE.GridHelper(
          gridSize,
          Math.round(gridSize / 10),
          GRID_COLOR,
          GRID_COLOR,
        );
        (grid.material as THREE.Material).transparent = true;
        (grid.material as THREE.Material).opacity = 0.3;
        r.scene.add(grid);

        // Frame the part.
        const radius = Math.max(size.length() / 2, 10);
        r.camera.position.set(radius * 1.7, radius * 1.5, radius * 2.1);
        r.controls.target.set(0, size.y / 2, 0);
        r.controls.update();
        r.frame();

        if (!disposed) setLoading(false);
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
  }, [src]);

  return (
    <div className="absolute inset-0 bg-muted/30">
      <div ref={mountRef} className="absolute inset-0" />
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
