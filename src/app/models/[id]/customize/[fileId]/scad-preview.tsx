"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { Loader2, TriangleAlert } from "lucide-react";

// The viewport's fixed scene pieces, created once per mount. Rendering is
// on-demand (orbit change / resize / new geometry), not a rAF loop — the
// scene is static between interactions and this keeps laptops cool.
type SceneRefs = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  mesh: THREE.Mesh | null;
  grid: THREE.GridHelper | null;
  frame: () => void;
};

const MODEL_COLOR = 0xd9d9de;
const GRID_COLOR = 0x8b8f96;

export function ScadPreview({
  data,
  rendering,
  error,
}: {
  // Binary STL bytes from the preview endpoint; null until the first render.
  data: ArrayBuffer | null;
  rendering: boolean;
  error: string | null;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const refs = useRef<SceneRefs | null>(null);

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
      10_000,
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

    refs.current = { renderer, scene, camera, controls, mesh: null, grid: null, frame };
    frame();

    return () => {
      observer.disconnect();
      controls.dispose();
      refs.current?.mesh?.geometry.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      refs.current = null;
    };
  }, []);

  useEffect(() => {
    const r = refs.current;
    if (!r || !data || data.byteLength === 0) return;

    let geometry: THREE.BufferGeometry;
    try {
      geometry = new STLLoader().parse(data);
    } catch {
      return; // malformed bytes — keep showing the previous mesh
    }
    geometry.computeVertexNormals();
    // OpenSCAD is Z-up, three.js is Y-up; stand the part on the plate.
    geometry.rotateX(-Math.PI / 2);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const center = box.getCenter(new THREE.Vector3());
    geometry.translate(-center.x, -box.min.y, -center.z);

    if (r.mesh) {
      r.scene.remove(r.mesh);
      r.mesh.geometry.dispose();
      (r.mesh.material as THREE.Material).dispose();
    }
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: MODEL_COLOR,
        roughness: 0.55,
        metalness: 0.05,
      }),
    );
    r.scene.add(mesh);
    r.mesh = mesh;

    // Size the "build plate" grid to the part (10 mm cells, min 100 mm).
    const size = box.getSize(new THREE.Vector3());
    const gridSize = Math.max(100, Math.ceil((Math.max(size.x, size.z) * 1.8) / 20) * 20);
    if (r.grid) {
      r.scene.remove(r.grid);
      r.grid.geometry.dispose();
      (r.grid.material as THREE.Material).dispose();
    }
    const grid = new THREE.GridHelper(gridSize, gridSize / 10, GRID_COLOR, GRID_COLOR);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.3;
    r.scene.add(grid);
    r.grid = grid;

    // Frame the part only on the first load — later previews keep the user's
    // camera so tweaking a value doesn't yank the view around.
    if (!r.controls.target.lengthSq()) {
      const radius = Math.max(size.length() / 2, 10);
      r.camera.position.set(radius * 1.7, radius * 1.5, radius * 2.1);
      r.controls.target.set(0, size.y / 2, 0);
      r.controls.update();
    }
    r.frame();
  }, [data]);

  return (
    <div className="relative min-h-0 flex-1 bg-muted/30">
      <div ref={mountRef} className="absolute inset-0" />
      {rendering && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/40 backdrop-blur-[2px]">
          <div className="flex items-center gap-2 rounded-lg border bg-background/90 px-4 py-2.5 text-sm shadow-sm">
            <Loader2 className="size-4 animate-spin" />
            Rendering preview…
          </div>
        </div>
      )}
      {error && !rendering && (
        <div className="absolute inset-x-0 bottom-4 flex justify-center px-4">
          <div className="flex max-w-lg items-start gap-2 rounded-lg border border-destructive/40 bg-background/95 px-4 py-2.5 text-sm shadow-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        </div>
      )}
      {!data && !rendering && !error && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">
            The preview appears here once the first render finishes.
          </p>
        </div>
      )}
    </div>
  );
}
