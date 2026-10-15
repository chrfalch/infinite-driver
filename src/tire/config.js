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
// Grip on dry ground, as multiples of the tyre's friction setting (1.1 by default). Measured μ for
// a tyre on: a graded, compacted dirt road about 0.75–0.8 (0.65–0.7 sliding), loose desert soil
// about 0.5–0.6, clean sandstone about 1. Loose soil and gravel take grip off the dirt: the top
// layer shears and the stones roll under the tread. Once the tread slides it grips less than it
// held (slideGrip, falling over slideSpeed m/s of slip), so a wheel that breaks loose keeps
// spinning until the driver lifts.
export const SURFACE_GRIP = Object.freeze({
  dirt: 0.75,
  rock: 1.0,
  road: 0.72, // graded, compacted road (the canyon's), whatever the soil around it is like
  asphalt: 1.0, // the town's paved streets and sidewalks (dry asphalt, μ about 1)
  softSoil: 0.5, // share of the dirt grip lost at softness 1
  gravel: 0.25, // share lost at gravel 1
  slideGrip: 0.8, // dirt
  roadSlideGrip: 0.88, // a compacted road holds its surface when a tyre locks on it
  asphaltSlideGrip: 0.85,
  rockSlideGrip: 0.9,
  slideSpeed: 0.5, // m/s
});

// Loose soil off the road (Bekker / Janosi soil mechanics, simplified). Soil resists a tyre two
// ways rubber on a hard surface does not:
//   cohesion  the soil's own shear strength, kPa over the contact patch, added to μ·N: a bigger
//             patch (lower pressure) pulls and stops harder;
//   plough    the tread sinks and keeps pushing soil ahead of it (motion resistance), about
//             plough·√(sinkage / diameter) of the load against the travel, so tall tyres and low
//             pressures (shallow sinkage) roll easier, and a locked wheel builds a wedge of soil.
// Both are scaled by the ground's softness relative to DEFAULT_GROUND.softness.
export const SOIL = Object.freeze({
  cohesionKpa: 3, // dry sandy loam
  plough: 0.8,
});

// The world's snow (terrain/snow.js), or null on soil. Set once per page (and per worker) from the
// height field, as the world is fixed for a page load.
let snowCover = null;
export function setSnowCover(snow) {
  snowCover = snow ?? null;
}
export function currentSnow() {
  return snowCover;
}

// Whether the world's roads are paved (the town's asphalt) rather than graded dirt: they grip like
// asphalt and carry no loose stones. Set once per page (and per worker) like the snow.
let pavedRoads = false;
export function setPavedRoads(paved) {
  pavedRoads = !!paved;
}

export function effectiveGpuTire(gpu, performance, ground = GROUND, snow = snowCover) {
  // Loose soil and gravel grip less than packed dirt (see SURFACE_GRIP).
  // Bare rock grips better than dusty ground (rubber on sandstone), and soil does not soften it.
  // On snow the ground grid's second channel is the snow (0 fresh, 1 packed, 2 bare asphalt; see
  // snowPacking in gpu-tires.js) instead of the rock flag: the solver blends stiffness and grip by it.
  const withSoil = snow
    ? {
        ...gpu,
        snow: 1,
        soilStiffness: snow.freshStiffness,
        packedStiffness: snow.packedStiffness,
        soilRebound: snow.rebound,
        friction: gpu.friction * snow.freshGrip,
        rockFriction: gpu.friction * snow.packedGrip,
        bareFriction: gpu.friction * snow.asphaltGrip,
        iceFriction: gpu.friction * snow.iceGrip,
        snowSlide: snow.slideGrip,
        maxSink: snow.maxSink,
        gravel: 0,
      }
    : {
        ...gpu,
        soilStiffness: soilStiffness(ground.softness),
        friction: gpu.friction * dirtGrip(ground),
        roadFriction: gpu.friction * (pavedRoads ? SURFACE_GRIP.asphalt : SURFACE_GRIP.road),
        rockFriction: gpu.friction * SURFACE_GRIP.rock,
        slideGrip: SURFACE_GRIP.slideGrip,
        roadSlideGrip: pavedRoads ? SURFACE_GRIP.asphaltSlideGrip : SURFACE_GRIP.roadSlideGrip,
        roadGravel: pavedRoads ? 0 : 0.5,
        rockSlideGrip: SURFACE_GRIP.rockSlideGrip,
        slideSpeed: SURFACE_GRIP.slideSpeed,
        cohesion: SOIL.cohesionKpa * 1000 * soilShare(ground),
        plough: SOIL.plough * soilShare(ground),
        gravel: ground.gravel,
      };
  if (!performance) return withSoil;
  return { ...withSoil, substeps: Math.min(gpu.substeps, 3), iterations: Math.min(gpu.iterations, 6), segmentsAround: 32, segmentsAcross: 8 };
}

// The grip (μ) the GPU tyres get on the ground at a point, from effectiveGpuTire's settings and
// heightAt.groundAt's { road, rock } there: the solver's dry-ground grip (dirt blended toward the
// road's by its share, bare rock its own), or fresh snow's on snow. Rigid wheels take theirs from
// it (see applyDriverInput), so they grip what the tyres would.
export function surfaceGrip(gpu, ground) {
  if (gpu.snow) return gpu.friction;
  if (ground?.rock > 0.5) return gpu.rockFriction;
  const road = Math.min(1, Math.max(0, ground?.road ?? 0));
  return gpu.friction + (gpu.roadFriction - gpu.friction) * road;
}

// Grip on soil for the ground settings, as a multiple of the tyre's friction setting.
export function dirtGrip(ground) {
  const g = SURFACE_GRIP;
  return g.dirt * (1 - g.softSoil * ground.softness) * (1 - g.gravel * ground.gravel);
}

// How strongly the soil's cohesion and plough act, from the softness: none on hard ground, as
// SOIL says at the default softness.
export function soilShare(ground) {
  return Math.max(0, ground.softness) / DEFAULT_GROUND.softness;
}

// Ground settings shared by the tyres and the track renderer. Softness is the loose soil off the
// roads (and the dry river's sand); the canyon's graded roads are hard whatever it is.
export const DEFAULT_GROUND = Object.freeze({
  softness: 0.4, // 0 = hard, 1 = very soft soil
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

// Soil spring stiffness per tyre particle of the default tyre for a softness in 0..1 (0 = hard
// ground, no spring). The solver scales it by each particle's tread area, so it is really a
// stiffness per square metre and other tyre sizes and mesh resolutions sink alike at one pressure.
export function soilStiffness(softness) {
  if (softness <= 0) return 0;
  return 30000 * (1 - softness) ** 2 + 1500;
}
