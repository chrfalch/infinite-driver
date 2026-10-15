// Trophy-truck body panels over the sand buggy's tube chassis (visual only), from the "Chevy S-10
// Stepside Extended Cab 2001" model by digitalcos (blendswap.com/blend/11649, CC BY), bent onto the
// chassis by scripts/trophy-body/convert_s10.py: hood and wide fenders, the cab round the cage, the
// stepside bed sides with the bed left open over the V8, and big arches with flare lips.
//
// Exported in the chassis' frame on the design wheelbase (x forward, y up, z right); each vertex is
// moved with the frame stretch here, like the tubes (see stretchX). The headlamp and tail lamp
// lenses share the chassis' headlamp and brake light materials, so they light up with them.
import { Color, DoubleSide, Group, MeshStandardMaterial } from 'three/webgpu';
import { abs, clamp, mix, positionLocal, reference, step } from 'three/tsl';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CAR } from '../vehicle/config.js';
import { stretchX } from '../vehicle/physics.js';
import { brakeLightMaterial, headlampMaterial } from './tube-chassis.js';

// The headlamps' centre (design frame, right side), for the spot lights (see headlights.js).
export const BODY_HEADLAMP = Object.freeze({ x: 2.1, y: 0.1, z: 0.86 });

// Liveries: the body colour, a stripe down the middle of the hood and roof and along the sides
// at the belt line, and pinstripes either side of it.
export const LIVERIES = {
  gulf: { name: 'Gulf blue', base: '#8fc6e4', stripe: '#f08a24', pin: '#1d3557' },
  red: { name: 'Race red', base: '#c8202b', stripe: '#f4f1ea', pin: '#1e2022' },
  yellow: { name: 'Baja yellow', base: '#f2c230', stripe: '#1e2022', pin: '#c8202b' },
  black: { name: 'Black', base: '#202225', stripe: '#f08a24', pin: '#f4f1ea' },
  white: { name: 'White', base: '#f2efe6', stripe: '#c8202b', pin: '#1d3557' },
};

// The livery's colours live on each paint material (liveryBase, liveryStripe, liveryPin).
function setPaintColours(material, key) {
  const l = LIVERIES[key] ?? LIVERIES.gulf;
  (material.liveryBase ??= new Color()).set(l.base);
  (material.liveryStripe ??= new Color()).set(l.stripe);
  (material.liveryPin ??= new Color()).set(l.pin);
}

// The paint, striped by where it is on the body (chassis frame; the stripes don't follow the
// frame stretch, which only moves them along their length), in livery `key`.
function paintMaterial(key) {
  const material = new MeshStandardMaterial({ roughness: 0.3, metalness: 0.05, side: DoubleSide });
  setPaintColours(material, key);
  const p = positionLocal;
  const across = abs(p.z);
  const band = (lo, hi, v) => step(lo, v).sub(step(hi, v));
  const top = step(0.3, p.y).mul(step(across, 0.62)); // hood, roof
  const sides = step(0.62, across).mul(step(across, 0.79)); // doors, bed sides (not the flares)
  const stripe = band(0, 0.15, across).mul(top).add(band(0.05, 0.15, p.y).mul(sides));
  const pin = band(0.15, 0.19, across).mul(top).add(band(0.02, 0.05, p.y).add(band(0.15, 0.18, p.y)).mul(sides));
  const colour = (name) => reference(name, 'color', material);
  material.colorNode = mix(mix(colour('liveryBase'), colour('liveryPin'), clamp(pin, 0, 1)), colour('liveryStripe'), clamp(stripe, 0, 1));
  // The renderer shares one compiled shader, bindings and all, between materials with the same
  // node graph: every car's paint then took one car's colours. Each paint is its own program.
  material.customProgramCacheKey = () => `paint-${material.uuid}`;
  return material;
}

const MATERIALS = {
  // The player's paint (the panel's choice, see setLivery); other cars have their own (bodyMaterials).
  Paint: paintMaterial(CAR.livery),
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

// A car's own paint in livery `key` and its own tail lamps (`tail`, its brake light material), for
// a car other than the player's, so it neither changes with the panel's livery nor lights up with
// the player's brakes.
export function bodyMaterials(key, tail) {
  return { Paint: paintMaterial(key), Tail: tail };
}

// The player's livery.
export function setLivery(key) {
  setPaintColours(MATERIALS.Paint, key);
}

// The body for the current frame stretch; filled in when the model has loaded. `materials`
// replaces some of the shared ones (see bodyMaterials).
export function createTrophyBody({ stretch, materials = null } = {}) {
  const own = materials ? { ...MATERIALS, ...materials } : MATERIALS;
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
        mesh.material = own[name] ?? own.Trim;
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
