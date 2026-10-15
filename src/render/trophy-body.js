// Trophy-truck body panels over the sand buggy's tube chassis (visual only), from the "Chevy S-10
// Stepside Extended Cab 2001" model by digitalcos (blendswap.com/blend/11649, CC BY), bent onto the
// chassis by scripts/trophy-body/convert_s10.py: hood and wide fenders, the cab round the cage, the
// stepside bed sides with the bed left open over the V8, and big arches with flare lips.
//
// Exported in the chassis' frame on the design wheelbase (x forward, y up, z right); each vertex is
// moved with the frame stretch here, like the tubes (see stretchX). The headlamp and tail lamp
// lenses share the chassis' headlamp and brake light materials, so they light up with them.
import { DoubleSide, Group, MeshStandardMaterial } from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { stretchX } from '../vehicle/physics.js';
import { brakeLightMaterial, headlampMaterial } from './tube-chassis.js';

// The headlamps' centre (design frame, right side), for the spot lights (see headlights.js).
export const BODY_HEADLAMP = Object.freeze({ x: 2.1, y: 0.1, z: 0.86 });

const MATERIALS = {
  Paint: new MeshStandardMaterial({ color: '#f2efe6', roughness: 0.32, metalness: 0.05, side: DoubleSide }),
  Trim: new MeshStandardMaterial({ color: '#1e2022', roughness: 0.6, metalness: 0.1, side: DoubleSide }),
  Chrome: new MeshStandardMaterial({ color: '#c9ccd0', roughness: 0.2, metalness: 0.9, side: DoubleSide }),
  Glass: new MeshStandardMaterial({ color: '#1d2b33', roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.45, depthWrite: false, side: DoubleSide }),
  Headlamp: headlampMaterial,
  Signal: new MeshStandardMaterial({ color: '#f2a31b', emissive: '#f28a1b', emissiveIntensity: 0.15, roughness: 0.3, side: DoubleSide }),
  Tail: brakeLightMaterial,
};

const MODEL_URL = () => `${(typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/'}models/trophy-body.glb`;
let modelPromise = null;
function loadModel() {
  if (typeof document === 'undefined') return null; // unit tests, workers
  modelPromise ??= new GLTFLoader().loadAsync(MODEL_URL()).then((gltf) => gltf.scene);
  return modelPromise;
}

// The body for the current frame stretch; filled in when the model has loaded.
export function createTrophyBody({ stretch } = {}) {
  const object = new Group();
  object.name = 'trophy body';
  const loading = loadModel();
  loading
    ?.then((scene) => {
      scene.traverse((o) => {
        if (!o.isMesh) return;
        const mesh = o.clone();
        // Each car gets its own copy of the vertices, moved with its frame stretch.
        mesh.geometry = o.geometry.clone();
        const pos = mesh.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) pos.setX(i, stretchX(pos.getX(i), undefined, stretch));
        pos.needsUpdate = true;
        mesh.geometry.computeBoundingSphere();
        const name = o.material?.name;
        mesh.material = MATERIALS[name] ?? MATERIALS.Trim;
        mesh.castShadow = name !== 'Glass';
        mesh.receiveShadow = true;
        o.updateWorldMatrix(true, false);
        mesh.matrix.copy(o.matrixWorld);
        mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
        object.add(mesh);
      });
    })
    .catch((e) => console.warn('trophy body: model failed to load', e));
  return { object, ready: loading ?? Promise.resolve() };
}
