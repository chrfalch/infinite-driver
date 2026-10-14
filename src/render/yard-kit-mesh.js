// The yard kit's models (scripts/yard-kit/build_kit.py, public/models/yard-kit.glb), loaded once
// as one geometry per model for render/props-mesh.js's instanced meshes: the model's parts merged,
// with its colours (the alpha marking its repaintable colour dropped), and moved so its origin is
// the middle of its box (where the physics body's is) instead of its base.
import { BufferAttribute, BufferGeometry } from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { YARD_KIT } from '../terrain/yard-kit.js';

const MODEL_URL = () => `${(typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/'}models/yard-kit.glb`;

let geometries = null;
let loading = null;

export function loadYardKit() {
  loading ??= new GLTFLoader().loadAsync(MODEL_URL()).then((gltf) => (geometries = yardGeometriesFrom(gltf.scene)));
  return loading;
}

export const yardGeometries = () => geometries;

// Per kit name, its geometry (exported for the tests).
export function yardGeometriesFrom(scene) {
  scene.updateMatrixWorld(true);
  const out = new Map();
  for (const k of YARD_KIT) {
    const root = scene.getObjectByName(k.name);
    if (!root) throw new Error(`yard kit: no model named ${k.name}`);
    const parts = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      const g = new BufferGeometry();
      const src = o.geometry;
      g.setAttribute('position', src.attributes.position.clone());
      g.setAttribute('normal', src.attributes.normal.clone());
      const col = src.attributes.color;
      const n = src.attributes.position.count;
      const rgb = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        rgb[i * 3] = col ? col.getX(i) : 1;
        rgb[i * 3 + 1] = col ? col.getY(i) : 1;
        rgb[i * 3 + 2] = col ? col.getZ(i) : 1;
      }
      g.setAttribute('color', new BufferAttribute(rgb, 3));
      if (src.index) g.setIndex(src.index.clone());
      g.applyMatrix4(o.matrixWorld);
      parts.push(g);
    });
    const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts);
    merged.translate(0, -k.h / 2, 0);
    out.set(k.name, merged);
  }
  return out;
}
