import { loadSettings, saveSettings } from '../settings-store.js';

// Soft-body tyre settings (Rapier soft body). Frequencies are the natural frequency, in Hz,
// of each constraint type; higher means stiffer. Extra substeps keep stiff settings stable.
//
// Rapier's volume constraint keeps a target volume rather than applying a pressure force, so
// "inflation" (target volume) is the main air-pressure control: more air stretches the cords
// and stiffens the tyre. "airStiffness" is how firmly that volume is held.
export const DEFAULT_TIRE = Object.freeze({
  outerRadius: 0.46,
  rimRadius: 0.27,
  width: 0.32,
  segmentsAround: 24,
  segmentsAcross: 8,

  inflation: 1.05, // target air volume / moulded volume
  airStiffness: 400, // volume-preservation stiffness (Hz)
  carcassStiffness: 500, // structural edges (Hz): cords that resist stretching
  sidewallStiffness: 60, // bending (Hz)
  shapeMemory: 40, // shape matching (Hz): pull back to the moulded shape
  damping: 0.3, // damping ratio of every constraint (higher wastes energy as rolling loss)
  beadRings: 1, // extra particle rings each side of the bead pinned to the rim
  substeps: 2, // extra solver substeps for the tyre and what it touches
  pgsIterations: 3, // extra solver iterations per substep; fewer is faster but softer
  rubberMass: 12, // kg per tyre
  friction: 1.1,
});

// v2: saves only changed values (v1 held full copies with stale defaults).
const STORAGE_KEY = 'drift.tire.v2';
const clone = (v) => JSON.parse(JSON.stringify(v));

const load = () => loadSettings(STORAGE_KEY);

export const TIRE = clone(DEFAULT_TIRE);
for (const [key, value] of Object.entries(load())) {
  if (typeof value === typeof DEFAULT_TIRE[key]) TIRE[key] = value;
}

export function saveTire() {
  saveSettings(STORAGE_KEY, DEFAULT_TIRE, TIRE);
}

export function resetTire() {
  Object.assign(TIRE, clone(DEFAULT_TIRE));
  saveTire();
}

// GPU tyre solver settings (see gpu-tire-solver.js). Geometry comes from TIRE.
export const DEFAULT_GPU_TIRE = Object.freeze({
  pressureKpa: 45, // gauge air pressure (about 6.5 psi, a rock-crawling pressure that lets the tyre wrap rocks)
  segmentsAround: 40,
  segmentsAcross: 10,
  beadRings: 1,
  substeps: 4,
  iterations: 8,
  cordStiffness: 1.0, // per Jacobi pass, 0..1
  shearStiffness: 1.0,
  bendStiffness: 0.3,
  shapeStiffness: 0.1, // pull toward the moulded shape per pass (across the tread)
  treadShapeRadial: 0, // share of that pull kept radially on the tread (0 lets rocks dent it)
  // The belt: rubber that grows more than beltStretch past its moulded radius is pulled back by
  // beltPull of the excess per pass. Without it the pressure balloons the tyre (7 % at 45 kPa and
  // the default size, 30 % at 165 kPa on a 0.55 x 0.6 m tyre), so few particles touch the ground.
  beltStretch: 0.02, // 0 = off
  beltPull: 0.3,
  treadBend: 0.1, // per pass: the tread keeps its moulded curve, so it flattens over a length instead of denting
  rockFloor: 0.03, // m: how far below bare rock the solver stops a particle (hard stop)
  sidewallBulge: 2.5, // sidewalls push out this much per metre the tread is pushed in (0 = no bulge)
  beadPull: 0.5, // fraction of the gap to the rim seat closed per pass
  damping: 2, // 1/s, relative to the wheel's rigid motion
  friction: 1.1,
  contactRadius: 0.02,
  relaxation: 1.0,
  // Do not wait for the GPU each step (forces arrive one step late). Faster, but the wheel spin
  // coupling goes unstable with the current tyre stiffness, so it is off for now.
  pipelined: false,
  // Physics steps per GPU round trip (1..4). Each round trip has a fixed cost, so more steps per
  // trip leave more time for everything else; between the steps of a trip the GPU moves the hubs.
  stepsPerTrip: 4,
  pressureLead: 1.0, // substeps of spin the pressure normal is turned ahead (cancels spin drag)
  rubberMass: 12,
});

const GPU_STORAGE_KEY = 'drift.gputire.v2';
const loadGpu = () => loadSettings(GPU_STORAGE_KEY);
export const GPU_TIRE = { ...DEFAULT_GPU_TIRE };
for (const [key, value] of Object.entries(loadGpu())) {
  if (typeof value === typeof DEFAULT_GPU_TIRE[key]) GPU_TIRE[key] = value;
}
// ?trip=N overrides the steps per GPU round trip for this page load (not saved).
const tripParam = Number(new URLSearchParams(globalThis.location?.search ?? '').get('trip'));
if (tripParam >= 1) GPU_TIRE.stepsPerTrip = tripParam;
export function saveGpuTire() {
  saveSettings(GPU_STORAGE_KEY, DEFAULT_GPU_TIRE, GPU_TIRE);
}
export function resetGpuTire() {
  Object.assign(GPU_TIRE, DEFAULT_GPU_TIRE);
  saveGpuTire();
}

// Settings actually used, with the performance preset applied on top when it is on.
export function effectiveTire(tire, performance) {
  if (!performance) return tire;
  return { ...tire, pgsIterations: 1, substeps: 1, segmentsAround: 20, segmentsAcross: 6 };
}
// Tyre friction on rock, as a multiple of the tyre's friction setting.
export const ROCK_GRIP = 2;

export function effectiveGpuTire(gpu, performance, ground = GROUND) {
  // Loose soil grips less than firm ground.
  // Bare rock grips better than dusty ground (rubber on sandstone), and soil does not soften it.
  const withSoil = { ...gpu, soilStiffness: soilStiffness(ground.softness), friction: gpu.friction * (1 - 0.4 * ground.softness), rockFriction: gpu.friction * ROCK_GRIP, gravel: ground.gravel };
  if (!performance) return withSoil;
  return { ...withSoil, substeps: Math.min(gpu.substeps, 3), iterations: Math.min(gpu.iterations, 6), segmentsAround: 32, segmentsAcross: 8 };
}

// Ground settings shared by the tyres and the track renderer.
export const DEFAULT_GROUND = Object.freeze({
  softness: 0.15, // 0 = hard, 1 = very soft soil
  gravel: 0.6, // 0 = smooth, 1 = coarse loose gravel the tread rolls over
  tracks: true,
  trackLength: 1500, // segments kept per wheel
});
const GROUND_KEY = 'drift.ground.v2';
const loadGround = () => loadSettings(GROUND_KEY);
export const GROUND = { ...DEFAULT_GROUND };
for (const [key, value] of Object.entries(loadGround())) {
  if (typeof value === typeof DEFAULT_GROUND[key]) GROUND[key] = value;
}
export function saveGround() {
  saveSettings(GROUND_KEY, DEFAULT_GROUND, GROUND);
}
export function resetGround() {
  Object.assign(GROUND, DEFAULT_GROUND);
  saveGround();
}

// Soil spring stiffness per tyre particle for a softness in 0..1 (0 = hard ground, no spring).
export function soilStiffness(softness) {
  if (softness <= 0) return 0;
  return 30000 * (1 - softness) ** 2 + 1500;
}
