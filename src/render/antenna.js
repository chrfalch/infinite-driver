import {
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  TorusGeometry,
  Vector3,
} from 'three/webgpu';
import { stretchX } from '../vehicle/physics.js';

// A fibreglass whip antenna with a pennant at the tip, on the rear of the roof. The whip's first
// bending mode is simulated as its tip: a point in world space sprung toward where the tip would
// be with the whip straight along the chassis' up, held at the whip's length from the base. The
// base moves with the drawn chassis, so a jolt, a pitch or roll, braking, and cornering whip it
// about; the air drags the tip back while driving and gravity bends it downhill on a slope. The
// drawn whip bends from the base to the tip like a cantilever. The pennant streams with the wind
// the tip feels and flaps.

export const WHIP = {
  length: 2.1, // m
  frequency: 1.2, // Hz, first bending mode
  damping: 0.08, // fraction of critical
  drag: 0.25, // 1/m, quadratic air drag on the tip (about 20° of lean at 15 m/s)
  gravity: -9.81,
  substep: 1 / 240,
  // A jump farther than this (respawn, reset) puts the whip back upright instead of flinging it.
  teleport: 3,
};

// Chassis-local mount: on top of the left roof rail near its rear end (the sand buggy's roof in
// tube-chassis.js runs from the main hoop at x -0.6 back to -1.5), moved back with the frame stretch.
export function antennaMount() {
  return new Vector3(stretchX(-1.3), 0.875, -0.484);
}

const UP = new Vector3(0, 1, 0);
const rest = new Vector3();
const restVelocity = new Vector3();
const stepBase = new Vector3();
const stepUp = new Vector3();
const f = new Vector3();
const d = new Vector3();

// Whip state: its tip and the tip's velocity (world), and the base and up it was last stepped to.
export function createWhip(base, up = UP, whip = WHIP) {
  const state = { whip, tip: new Vector3(), velocity: new Vector3(), base: new Vector3(), up: new Vector3(), carry: 0 };
  resetWhip(state, base, up);
  return state;
}

export function resetWhip(state, base, up) {
  state.base.copy(base);
  state.up.copy(up);
  state.tip.copy(base).addScaledVector(up, state.whip.length);
  state.velocity.set(0, 0, 0);
  state.carry = 0;
}

// Advances the whip by dt with its base now at `base` (world) and the chassis' up along `up`.
// The base and up move evenly across the substeps.
export function stepWhip(state, base, up, dt) {
  const { whip, tip, velocity } = state;
  if (base.distanceTo(state.base) > whip.teleport) {
    resetWhip(state, base, up);
    return;
  }
  const h = whip.substep;
  const w = 2 * Math.PI * whip.frequency;
  const k = w * w;
  const c = 2 * whip.damping * w;
  state.carry += dt;
  const steps = Math.floor(state.carry / h);
  state.carry -= steps * h;
  const from = state.base.clone();
  const fromUp = state.up.clone();
  // How fast the straight tip moves (for damping relative to the whip, not the air).
  restVelocity.copy(base).addScaledVector(up, whip.length).sub(from).addScaledVector(fromUp, -whip.length).divideScalar(Math.max(dt, 1e-4));
  for (let s = 1; s <= steps; s++) {
    stepBase.lerpVectors(from, base, s / steps);
    stepUp.lerpVectors(fromUp, up, s / steps).normalize();
    rest.copy(stepBase).addScaledVector(stepUp, whip.length);
    // Spring toward straight, damping relative to the straight tip, air drag, and gravity across
    // the whip (along it, the whip carries its own weight).
    f.subVectors(rest, tip).multiplyScalar(k);
    d.subVectors(velocity, restVelocity);
    f.addScaledVector(d, -c);
    f.addScaledVector(velocity, -whip.drag * velocity.length());
    f.y += whip.gravity;
    f.addScaledVector(stepUp, -whip.gravity * stepUp.y);
    velocity.addScaledVector(f, h);
    tip.addScaledVector(velocity, h);
    // Held at the whip's length from the base; no velocity along the whip.
    d.subVectors(tip, stepBase).normalize();
    tip.copy(stepBase).addScaledVector(d, whip.length);
    velocity.addScaledVector(d, -velocity.dot(d) + restVelocity.dot(d));
  }
  state.base.copy(base);
  state.up.copy(up);
}

// How far the tip has swung from straight up the chassis, as an angle (radians).
export function whipBend(state) {
  d.subVectors(state.tip, state.base).normalize();
  return Math.acos(Math.min(1, Math.max(-1, d.dot(state.up))));
}

// Point at s in [0, 1] along the bent whip: straight up out of the base, bending toward the tip
// like a cantilever under a load at its end.
export function whipPoint(state, s, out) {
  d.subVectors(state.tip, state.base);
  const along = d.dot(state.up);
  d.addScaledVector(state.up, -along); // sideways deflection of the tip
  const shape = (s * s * (3 - s)) / 2;
  return out.copy(state.base).addScaledVector(state.up, along * s).addScaledVector(d, shape);
}

// --- Drawing --------------------------------------------------------------------------------

const RINGS = 31; // rings along the drawn whip
const SIDES = 6;
const R_BASE = 0.013;
const R_TIP = 0.007;
const FLAG_COLS = 9;
const FLAG_LENGTH = 0.6; // m along the streaming edge
const FLAG_HEIGHT = 0.34; // m along the whip, at the hoist

const whipMat = new MeshStandardMaterial({ color: '#141414', roughness: 0.5, metalness: 0.1 });
const springMat = new MeshStandardMaterial({ color: '#cfd2d4', roughness: 0.25, metalness: 0.9 });
const flagMat = new MeshStandardMaterial({ color: '#ff5a1a', emissive: '#ff3a00', emissiveIntensity: 0.25, roughness: 0.8, side: DoubleSide });

function tubeGeometry() {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(RINGS * SIDES * 3 + 3), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(RINGS * SIDES * 3 + 3), 3));
  const index = [];
  for (let r = 0; r < RINGS - 1; r++) {
    for (let s = 0; s < SIDES; s++) {
      const a = r * SIDES + s;
      const b = r * SIDES + ((s + 1) % SIDES);
      index.push(a, a + SIDES, b, b, a + SIDES, b + SIDES);
    }
  }
  // Tip cap.
  const tip = RINGS * SIDES;
  for (let s = 0; s < SIDES; s++) index.push((RINGS - 1) * SIDES + s, tip, (RINGS - 1) * SIDES + ((s + 1) % SIDES));
  g.setIndex(index);
  return g;
}

function flagGeometry() {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(FLAG_COLS * 2 * 3), 3));
  const index = [];
  for (let c = 0; c < FLAG_COLS - 1; c++) {
    const a = c * 2;
    index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  g.setIndex(index);
  return g;
}

const inv = new Quaternion();
const carPos = new Vector3();
const worldBase = new Vector3();
const worldUp = new Vector3();
const ring = Array.from({ length: RINGS }, () => new Vector3());
const tangent = new Vector3();
const side = new Vector3();
const normal = new Vector3();
const ref = new Vector3();
const wind = new Vector3();
const fly = new Vector3();
const flap = new Vector3();
const q = new Vector3();
const tipVelocity = new Vector3();

// The antenna for a car view: a spring-mounted base fixed to the chassis, the whip, and the pennant.
// Call update(car, dt) every frame with the car's drawn object (position and quaternion set).
export function createAntenna() {
  const mountAt = antennaMount();
  const group = new Group();
  group.name = 'antenna';
  // Mount: a bracket tab on the roof tube and a short chrome coil spring the whip sits in.
  const mount = new Group();
  mount.position.copy(mountAt);
  const tab = new Mesh(new CylinderGeometry(0.022, 0.026, 0.03, 12), whipMat);
  tab.position.y = -0.03;
  mount.add(tab);
  for (let i = 0; i < 5; i++) {
    const coil = new Mesh(new TorusGeometry(0.013, 0.0035, 6, 14), springMat);
    coil.rotation.x = Math.PI / 2;
    coil.position.y = -0.012 + i * 0.011;
    mount.add(coil);
  }
  for (const m of mount.children) m.castShadow = true;
  group.add(mount);

  const tube = new Mesh(tubeGeometry(), whipMat);
  tube.castShadow = true;
  tube.frustumCulled = false;
  const flag = new Mesh(flagGeometry(), flagMat);
  flag.castShadow = true;
  flag.frustumCulled = false;
  group.add(tube, flag);

  let state = null;
  let phase = 0;
  const lastTip = new Vector3();
  const flyDir = new Vector3(-1, 0, 0);

  function update(car, dt) {
    carPos.copy(car.position);
    worldBase.copy(mountAt).applyQuaternion(car.quaternion).add(carPos);
    worldUp.copy(UP).applyQuaternion(car.quaternion);
    if (!state) {
      state = createWhip(worldBase, worldUp);
      lastTip.copy(state.tip);
    } else stepWhip(state, worldBase, worldUp, dt);

    // The bent whip, chassis-local.
    inv.copy(car.quaternion).invert();
    for (let r = 0; r < RINGS; r++) whipPoint(state, r / (RINGS - 1), ring[r]).sub(carPos).applyQuaternion(inv);
    drawTube(tube.geometry);

    // Wind at the tip (chassis-local): the still air flowing past it, with a little breeze from
    // ahead-right so a parked car's pennant still lifts.
    const tipWorld = state.tip;
    tipVelocity.subVectors(tipWorld, lastTip).divideScalar(Math.max(dt, 1e-3));
    if (tipVelocity.length() > 60) tipVelocity.set(0, 0, 0); // a reset
    lastTip.copy(tipWorld);
    wind.copy(tipVelocity).negate().applyQuaternion(inv).add(ref.set(-2.5, 0, -1.2));
    const speed = wind.length();
    drawFlag(flag.geometry, dt, speed);
  }

  function drawTube(g) {
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    ref.set(1, 0, 0);
    for (let r = 0; r < RINGS; r++) {
      tangent.subVectors(ring[Math.min(RINGS - 1, r + 1)], ring[Math.max(0, r - 1)]).normalize();
      side.crossVectors(tangent, ref).normalize();
      normal.crossVectors(side, tangent);
      ref.copy(normal); // carry the frame along so the tube does not twist
      const radius = R_BASE + (R_TIP - R_BASE) * (r / (RINGS - 1));
      for (let s = 0; s < SIDES; s++) {
        const a = (s / SIDES) * Math.PI * 2;
        q.copy(side).multiplyScalar(Math.cos(a)).addScaledVector(normal, Math.sin(a));
        const k = r * SIDES + s;
        nor.setXYZ(k, q.x, q.y, q.z);
        pos.setXYZ(k, ring[r].x + q.x * radius, ring[r].y + q.y * radius, ring[r].z + q.z * radius);
      }
    }
    const tip = ring[RINGS - 1];
    pos.setXYZ(RINGS * SIDES, tip.x + tangent.x * R_TIP, tip.y + tangent.y * R_TIP, tip.z + tangent.z * R_TIP);
    nor.setXYZ(RINGS * SIDES, tangent.x, tangent.y, tangent.z);
    pos.needsUpdate = true;
    nor.needsUpdate = true;
  }

  // The pennant hangs from the top of the whip and streams downwind, perpendicular to the whip.
  // It flaps faster and harder in a stronger wind; with little wind it droops.
  function drawFlag(g, dt, speed) {
    const pos = g.getAttribute('position');
    const top = ring[RINGS - 1];
    const hoistBottom = ring[Math.round((RINGS - 1) * (1 - FLAG_HEIGHT / WHIP.length))];
    tangent.subVectors(top, hoistBottom).normalize();
    // Downwind, perpendicular to the whip, drooping toward the ground as the wind drops.
    fly.copy(wind).addScaledVector(tangent, -wind.dot(tangent));
    const lift = Math.min(1, speed / 6);
    if (fly.lengthSq() > 1e-6) fly.normalize();
    else fly.copy(flyDir);
    fly.multiplyScalar(0.25 + 0.75 * lift).addScaledVector(tangent, -(1 - lift) * 0.9).normalize();
    flyDir.lerp(fly, Math.min(1, dt * 8)).normalize();
    flap.crossVectors(tangent, flyDir).normalize();
    phase += dt * (5 + speed * 0.9);
    const amplitude = 0.02 + 0.05 * lift;
    for (let c = 0; c < FLAG_COLS; c++) {
      const u = c / (FLAG_COLS - 1);
      const wave = Math.sin(phase - u * 5.5) * amplitude * u + Math.sin(phase * 1.7 - u * 9) * amplitude * 0.3 * u;
      // The streaming edge shortens a little as it flaps (cloth does not stretch).
      const along = u * FLAG_LENGTH * (1 - 0.15 * lift * Math.abs(Math.sin(phase - u * 5.5)) * u);
      const height = FLAG_HEIGHT * (1 - u); // a pennant: tapers to a point
      for (let row = 0; row < 2; row++) {
        const k = c * 2 + row;
        // Top edge along the whip's top; bottom edge rises to meet it at the point.
        const drop = row === 0 ? FLAG_HEIGHT - (FLAG_HEIGHT - height) * 0.5 : (FLAG_HEIGHT - height) * 0.5;
        pos.setXYZ(
          k,
          top.x - tangent.x * drop + flyDir.x * along + flap.x * wave,
          top.y - tangent.y * drop + flyDir.y * along + flap.y * wave,
          top.z - tangent.z * drop + flyDir.z * along + flap.z * wave,
        );
      }
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
  }

  return { object: group, update, get whip() { return state; } };
}
