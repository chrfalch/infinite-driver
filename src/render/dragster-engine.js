// A Hemi V8 for the engine bay behind the seats (visual only), from the "Dragster Engine" model by
// its Blend Swap author (blendswap.com/blends/view/84608, CC BY 3.0), converted with its blower
// taken off by scripts/dragster-engine/export.py. Its moving parts follow the drivetrain: the
// crank and idler pulleys turn with the revs and a toothed belt runs around them; the throttle
// opens the injector hat's butterflies, whose arm pushes a rod to the fuel barrel valve's arm and stretches
// the return spring; and the engine rocks on its mounts with the torque it makes.
//
// Engine-local frame (as exported): chassis axes (x forward, y up, z right), the origin on the
// crank axis at the pulley plane, the crankshaft along x and the pulleys facing forward.
import {
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Sphere,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeByMaterial } from './merge-geometry.js';

const TWO_PI = Math.PI * 2;

// Materials by the model's material names (its Cycles node setups don't survive the export).
const std = (color, roughness, metalness) => new MeshStandardMaterial({ color, roughness, metalness });
const blackRubber = std('#121212', 0.8, 0);
const MATERIALS = {
  Aluminum: std('#c4c7c9', 0.4, 0.55),
  Aluminum_MSD_Ignition: std('#b4bac2', 0.35, 0.6),
  Black_Paint: std('#141414', 0.35, 0.2),
  Black_Rubber: blackRubber,
  'blackrubber.001': blackRubber,
  Blue_Metal: std('#3a55d0', 0.35, 0.5),
  Braided_Hose: std('#6a7072', 0.55, 0.75),
  Bronze: std('#c39352', 0.35, 0.6),
  Diffuse_Metal: std('#8f8c6c', 0.45, 0.6),
  Grey_Paint: std('#767a82', 0.35, 0.3),
  Grey_Rubber: std('#2a2a2a', 0.7, 0),
  Kev_Blanket: std('#1c1b19', 0.9, 0),
  'Red_Metal(MSD)': std('#b3211a', 0.4, 0.5),
  Red_Paint: std('#c8261c', 0.3, 0.2),
  Red_Rubber: std('#8a1810', 0.6, 0),
};
const fallback = std('#808080', 0.5, 0.5);
const beltMaterial = new MeshStandardMaterial({ color: '#1b1b1d', roughness: 0.75, metalness: 0, flatShading: true, side: DoubleSide });

export const BELT = {
  pitch: 0.012, // m between teeth (a 14 mm HTD blower belt at the model's scale)
  back: 0.0035, // m of belt outside the pulleys' tooth tips
  tooth: 0.004, // m the teeth reach in between the pulleys' teeth
  samples: 8, // cross-sections per tooth
};

// ---- Belt path ---------------------------------------------------------------------------------
// Pulleys as circles in the plane of the drive, 2D (p, q) = chassis (y, z): a positive turn about
// x carries p toward q, so a belt run counterclockwise in (p, q) moves with pulleys whose
// rotation.x increases. The belt wraps the pulleys' convex hull, each on its inside, so they all
// turn the same way.

// circles: [{ c: Vector2, r }]. Returns { segments, length } with lines and arcs in run order.
export function beltPath(circles) {
  const mid = circles.reduce((m, { c }) => m.add(c), new Vector2()).divideScalar(circles.length);
  const order = [...circles].sort((a, b) => Math.atan2(a.c.y - mid.y, a.c.x - mid.x) - Math.atan2(b.c.y - mid.y, b.c.x - mid.x));
  // Outward normal of the tangent from A to B (pulleys on the left of the run).
  const normals = order.map((A, i) => {
    const B = order[(i + 1) % order.length];
    const d = B.c.clone().sub(A.c);
    const L = d.length();
    d.divideScalar(L);
    const a = Math.asin((A.r - B.r) / L);
    const right = new Vector2(d.y, -d.x);
    return right.multiplyScalar(Math.cos(a)).add(d.multiplyScalar(Math.sin(a)));
  });
  const segments = [];
  let s = 0;
  order.forEach((A, i) => {
    const j = (i + 1) % order.length;
    const B = order[j];
    const n = normals[i];
    const from = A.c.clone().addScaledVector(n, A.r);
    const to = B.c.clone().addScaledVector(n, B.r);
    const len = from.distanceTo(to);
    segments.push({ line: true, s, length: len, from, dir: to.clone().sub(from).divideScalar(len), n: n.clone() });
    s += len;
    const a0 = Math.atan2(n.y, n.x);
    const n1 = normals[j];
    let sweep = Math.atan2(n1.y, n1.x) - a0;
    sweep = ((sweep % TWO_PI) + TWO_PI) % TWO_PI;
    segments.push({ line: false, s, length: sweep * B.r, c: B.c, r: B.r, a0 });
    s += sweep * B.r;
  });
  return { segments, length: s };
}

// Point and outward normal at run length s (wrapped) along the path.
export function beltPoint(path, s, point, normal) {
  s = ((s % path.length) + path.length) % path.length;
  const segs = path.segments;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (segs[m].s <= s) lo = m;
    else hi = m - 1;
  }
  const g = segs[lo];
  const t = s - g.s;
  if (g.line) {
    point.copy(g.from).addScaledVector(g.dir, t);
    normal.copy(g.n);
  } else {
    const a = g.a0 + t / g.r;
    normal.set(Math.cos(a), Math.sin(a));
    point.copy(g.c).addScaledVector(normal, g.r);
  }
  return point;
}

// A toothed belt (teeth inside) around the pulleys at x. update(offset) runs it `offset` m along.
export function createBelt(circles, x, width, belt = BELT) {
  const path = beltPath(circles);
  const teeth = Math.max(8, Math.round(path.length / belt.pitch));
  const count = teeth * belt.samples;
  const positions = new Float32Array(count * 4 * 3);
  const index = [];
  for (let i = 0; i < count; i++) {
    const a = i * 4;
    const b = ((i + 1) % count) * 4;
    // Corners: 0 back left, 1 back right, 2 tooth right, 3 tooth left.
    for (const [u, v] of [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
    ])
      index.push(a + u, b + u, b + v, a + u, b + v, a + v);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(index);
  // Teeth: a trapezoid over each pitch.
  const depth = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const f = (i % belt.samples) / belt.samples;
    depth[i] = Math.max(0, Math.min(1, Math.min(f - 0.05, 0.55 - f) / 0.12)) * belt.tooth;
  }
  const ds = path.length / count;
  const p = new Vector2();
  const n = new Vector2();
  const w = width / 2;
  const update = (offset) => {
    for (let i = 0; i < count; i++) {
      beltPoint(path, i * ds + offset, p, n);
      const out = belt.back;
      const inn = -depth[i];
      const k = i * 12;
      // (p, q) = chassis (y, z).
      positions[k] = x - w;
      positions[k + 1] = p.x + n.x * out;
      positions[k + 2] = p.y + n.y * out;
      positions[k + 3] = x + w;
      positions[k + 4] = positions[k + 1];
      positions[k + 5] = positions[k + 2];
      positions[k + 6] = x + w;
      positions[k + 7] = p.x + n.x * inn;
      positions[k + 8] = p.y + n.y * inn;
      positions[k + 9] = x - w;
      positions[k + 10] = positions[k + 7];
      positions[k + 11] = positions[k + 8];
    }
    geometry.attributes.position.needsUpdate = true;
  };
  update(0);
  geometry.computeBoundingBox();
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());
  geometry.boundingSphere.radius += 0.02;
  const mesh = new Mesh(geometry, beltMaterial);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'blower belt';
  return { mesh, path, update, teeth };
}

// ---- Throttle linkage --------------------------------------------------------------------------
// In the plane of the linkage (chassis x, y): the butterflies' shaft S carries an arm to the rod's
// top end T; the rod (fixed length) runs to the bottom end B on the barrel valve's arm about P.
// Turning the shaft by a moves T; the valve arm turns to keep the rod's length.

const rot2 = (v, a) => new Vector2(v.x * Math.cos(a) - v.y * Math.sin(a), v.x * Math.sin(a) + v.y * Math.cos(a));

// geo: { shaft, top, bottom, pivot } as Vector2. Returns the valve arm's turn (rad from rest) for
// a shaft turn a, the solution nearest `near`, or null where the rod can't reach.
export function solveLinkage(geo, a, near = 0) {
  const T = rot2(geo.top.clone().sub(geo.shaft), a).add(geo.shaft);
  const rodLength = geo.top.distanceTo(geo.bottom);
  const armLength = geo.bottom.distanceTo(geo.pivot);
  const d = T.clone().sub(geo.pivot);
  const D = d.length();
  // Circle (pivot, armLength) meets circle (T, rodLength).
  const x = (D * D + armLength * armLength - rodLength * rodLength) / (2 * D);
  const h2 = armLength * armLength - x * x;
  if (h2 < 0) return null;
  const base = Math.atan2(d.y, d.x);
  const off = Math.acos(Math.max(-1, Math.min(1, x / armLength)));
  const rest = Math.atan2(geo.bottom.y - geo.pivot.y, geo.bottom.x - geo.pivot.x);
  const wrap = (v) => Math.atan2(Math.sin(v), Math.cos(v));
  const c1 = wrap(base + off - rest);
  const c2 = wrap(base - off - rest);
  return Math.abs(c1 - near) <= Math.abs(c2 - near) ? c1 : c2;
}

// How far the shaft turns (rad, signed) at full throttle: toward stretching the return spring, as
// far as the rod reaches (with a margin), and no more than `limit`.
export function throttleTravel(geo, springEnd, limit = (70 * Math.PI) / 180) {
  const stretch = (a) => rot2(springEnd.moving.clone().sub(geo.shaft), a).add(geo.shaft).distanceTo(springEnd.fixed);
  const sign = stretch(0.05) > stretch(-0.05) ? 1 : -1;
  let a = 0;
  let near = 0;
  const step = Math.PI / 360;
  while (a + step <= limit) {
    const phi = solveLinkage(geo, sign * (a + step), near);
    if (phi === null || Math.abs(phi - near) > 0.2) break;
    near = phi;
    a += step;
  }
  return sign * a * 0.92;
}

// ---- Gearbox ----------------------------------------------------------------------------------
// A plain manual gearbox bolted to the back of the block (engine-local units, crank along x): a
// bellhousing flaring out to the block, a ribbed case, and a tail housing with the output flange.
// face: x of the block's flywheel face; the gearbox runs toward -x from there.
const castAlloy = std('#9a9da0', 0.55, 0.5);
const steel = std('#3a3c3f', 0.45, 0.7);
export const GEARBOX = { bell: 0.16, caseLength: 0.25, tail: 0.09 };

export function createGearbox(face) {
  const group = new Group();
  group.name = 'gearbox';
  const along = (geometry, material, x) => {
    const m = new Mesh(geometry, material);
    m.rotation.z = Math.PI / 2; // cylinder axis y → x
    m.position.x = x;
    m.castShadow = m.receiveShadow = true;
    group.add(m);
    return m;
  };
  const { bell, caseLength, tail } = GEARBOX;
  // Bellhousing: wide at the block, with a bolt flange.
  along(new CylinderGeometry(0.125, 0.19, bell, 20), castAlloy, face - bell / 2);
  along(new CylinderGeometry(0.2, 0.2, 0.015, 20), castAlloy, face - 0.0075);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const bolt = along(new CylinderGeometry(0.008, 0.008, 0.025, 6), steel, face - 0.02);
    bolt.position.y = Math.cos(a) * 0.185;
    bolt.position.z = Math.sin(a) * 0.185;
  }
  // Case: a box with ribs round it, and the shifter turret on top.
  const c0 = face - bell;
  const box = new Mesh(new BoxGeometry(caseLength, 0.19, 0.17), castAlloy);
  box.position.x = c0 - caseLength / 2;
  box.castShadow = box.receiveShadow = true;
  group.add(box);
  for (let i = 0; i < 4; i++) {
    const rib = new Mesh(new BoxGeometry(0.012, 0.205, 0.185), castAlloy);
    rib.position.x = c0 - 0.03 - (i * (caseLength - 0.06)) / 3;
    rib.castShadow = true;
    group.add(rib);
  }
  const turret = new Mesh(new CylinderGeometry(0.035, 0.04, 0.05, 12), castAlloy);
  turret.position.set(c0 - caseLength * 0.35, 0.12, 0);
  group.add(turret);
  const lever = new Mesh(new CylinderGeometry(0.008, 0.008, 0.16, 8), steel);
  lever.position.set(c0 - caseLength * 0.35 + 0.02, 0.21, 0);
  lever.rotation.z = -0.25;
  group.add(lever);
  // Tail housing and output flange.
  const t0 = c0 - caseLength;
  along(new CylinderGeometry(0.05, 0.065, tail, 14), castAlloy, t0 - tail / 2);
  along(new CylinderGeometry(0.045, 0.045, 0.02, 14), steel, t0 - tail - 0.01);
  const ring = new Mesh(new TorusGeometry(0.19, 0.006, 6, 24), steel);
  ring.rotation.y = Math.PI / 2;
  ring.position.x = face - 0.016;
  group.add(ring);
  return mergeByMaterial(group);
}

// ---- The engine --------------------------------------------------------------------------------

const MODEL_URL = () => `${(typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/'}models/dragster-engine.glb`;
let modelPromise = null;
function loadModel() {
  if (typeof document === 'undefined') return null; // unit tests, workers
  modelPromise ??= new GLTFLoader().loadAsync(MODEL_URL()).then((gltf) => {
    // The car's despawn disposes its geometries; these are shared by every car built.
    gltf.scene.traverse((o) => {
      if (o.isMesh) o.userData.sharedGeometry = true;
    });
    return gltf.scene;
  });
  return modelPromise;
}

const Y = new Vector3(0, 1, 0);
const v3 = (a) => new Vector3(a[0], a[1], a[2]);

// position: chassis-local spot of the crank pulley's centre; scale: of the exported model; yaw:
// turn about y (π puts the pulleys at the back and the flywheel toward the seats).
export function createDragsterEngine({ position = new Vector3(), scale = 1, yaw = 0 } = {}) {
  const object = new Group();
  object.name = 'dragster engine';
  object.position.copy(position);
  object.scale.setScalar(scale);
  object.rotation.y = yaw;
  // Rocks about the crank on its mounts.
  const mount = new Group();
  object.add(mount);

  let parts = null;
  const state = { belt: 0, rock: 0, rockRate: 0, throttle: 0, valve: 0, time: 0 };

  const build = (scene) => {
    const model = scene.clone(true);
    const node = (name) => model.getObjectByName(name);
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.material = MATERIALS[o.material?.name] ?? fallback;
      o.castShadow = true;
      o.receiveShadow = true;
    });
    const pulleys = ['crank', 'idler', 'blower'].map((name) => node(name)).filter(Boolean);
    const radii = pulleys.map((p) => p.userData.radius);
    const beltInfo = node('static').userData.belt;
    const belt = createBelt(
      pulleys.map((p, i) => ({ c: new Vector2(p.position.y, p.position.z), r: radii[i] })),
      beltInfo.x,
      beltInfo.width,
    );
    model.add(belt.mesh);

    const throttle = node('throttle');
    const valveArm = node('valveArm');
    const rod = node('rod');
    const springNode = node('spring');
    const xy = (v) => new Vector2(v.x, v.y);
    const geo = {
      shaft: xy(throttle.position),
      top: xy(rod.position),
      bottom: xy(v3(rod.userData.bottom)),
      pivot: xy(valveArm.position),
    };
    const rodRest = Math.atan2(geo.bottom.y - geo.top.y, geo.bottom.x - geo.top.x);
    // The spring hangs from a stud (fixed) to the left lever on the shaft (moving); its mesh is
    // turned so its axis is +y, then aimed and stretched between the ends each frame.
    const springFixed = springNode.position.clone();
    const springMoving = v3(springNode.userData.moving);
    const springAxis = springMoving.clone().sub(springFixed);
    const springRest = springAxis.length();
    const spring = new Group();
    spring.position.copy(springFixed);
    const springInner = new Group();
    springInner.quaternion.setFromUnitVectors(springAxis.clone().normalize(), Y);
    springNode.position.set(0, 0, 0);
    springInner.add(springNode);
    spring.add(springInner);
    model.add(spring);
    const travel = throttleTravel(geo, { fixed: xy(springFixed), moving: xy(springMoving) });

    mount.add(model);
    // The gearbox hangs off the flywheel face (the back of the block, the static mesh's -x end).
    model.updateMatrixWorld(true);
    mount.add(createGearbox(new Box3().setFromObject(node('static')).min.x));
    parts = { pulleys, radii, belt, throttle, valveArm, rod, geo, rodRest, spring, springFixed, springMoving, springRest, travel };
  };
  const loading = loadModel();
  loading?.then(build).catch((e) => console.warn('dragster engine: model failed to load', e));

  const shaftEnd = new Vector3();
  const springDir = new Vector3();
  const springQ = new Quaternion();

  // drivetrain: { rpm, throttle, fuel } (any may be missing).
  const update = (drivetrain, dt) => {
    if (!parts || !(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    const rpm = Math.max(0, drivetrain?.rpm ?? 0);
    const w = (rpm * TWO_PI) / 60;
    // The crank turns clockwise seen from the front: negative about +x. The belt and the other
    // pulleys go with it at the same surface speed.
    const turn = -w * dt;
    const rc = parts.radii[0];
    parts.pulleys.forEach((pulley, i) => (pulley.rotation.x = (pulley.rotation.x + (turn * rc) / parts.radii[i]) % TWO_PI));
    state.belt = (state.belt + turn * rc) % parts.belt.path.length;
    parts.belt.update(state.belt);

    // Throttle: the linkage follows the pedal quickly, and the return spring closes it.
    const target = Math.max(0, Math.min(1, drivetrain?.throttle ?? 0));
    state.throttle += (target - state.throttle) * Math.min(1, dt / 0.04);
    const a = state.throttle * parts.travel;
    parts.throttle.rotation.z = a;
    const phi = solveLinkage(parts.geo, a, state.valve);
    if (phi !== null) state.valve = phi;
    parts.valveArm.rotation.z = state.valve;
    const { geo } = parts;
    const T = rot2(geo.top.clone().sub(geo.shaft), a).add(geo.shaft);
    const B = rot2(geo.bottom.clone().sub(geo.pivot), state.valve).add(geo.pivot);
    parts.rod.position.x = T.x;
    parts.rod.position.y = T.y;
    parts.rod.rotation.z = Math.atan2(B.y - T.y, B.x - T.x) - parts.rodRest;
    const m = rot2(new Vector2(parts.springMoving.x - geo.shaft.x, parts.springMoving.y - geo.shaft.y), a);
    shaftEnd.set(m.x + geo.shaft.x, m.y + geo.shaft.y, parts.springMoving.z);
    springDir.subVectors(shaftEnd, parts.springFixed);
    const len = springDir.length();
    parts.spring.quaternion.copy(springQ.setFromUnitVectors(Y, springDir.divideScalar(len)));
    parts.spring.scale.set(1, len / parts.springRest, 1);

    // The block leans against the crank's torque (counterclockwise from the front) and shakes a
    // little at idle; a lightly damped spring on the mounts.
    state.time += dt;
    const fuel = Math.max(0, Math.min(1, drivetrain?.fuel ?? target));
    const idleShake = Math.max(0, 1 - rpm / 2500) * 0.004 * (Math.sin(state.time * 41) + 0.6 * Math.sin(state.time * 29.3));
    const want = 0.03 * fuel + idleShake;
    const k = (TWO_PI * 7) ** 2;
    const c = 2 * 0.3 * TWO_PI * 7;
    const steps = Math.ceil(dt / (1 / 240));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      state.rockRate += (k * (want - state.rock) - c * state.rockRate) * h;
      state.rock += state.rockRate * h;
    }
    mount.rotation.x = state.rock;
  };

  return {
    object,
    update,
    ready: loading ?? Promise.resolve(),
    get parts() {
      return parts;
    },
  };
}
