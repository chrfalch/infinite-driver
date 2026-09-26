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
  sidewallStiffness: 10, // bending (Hz)
  shapeMemory: 12, // shape matching (Hz): pull back to the moulded shape
  damping: 1.0, // damping ratio of every constraint
  beadRings: 1, // extra particle rings each side of the bead pinned to the rim
  substeps: 2, // extra solver substeps for the tyre and what it touches
  pgsIterations: 3, // extra solver iterations per substep; fewer is faster but softer
  rubberMass: 12, // kg per tyre
  friction: 1.1,
});

const STORAGE_KEY = 'drift.tire.v1';
const clone = (v) => JSON.parse(JSON.stringify(v));

function load() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export const TIRE = clone(DEFAULT_TIRE);
for (const [key, value] of Object.entries(load())) {
  if (typeof value === typeof DEFAULT_TIRE[key]) TIRE[key] = value;
}

export function saveTire() {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(TIRE));
  } catch {
    // Storage can be unavailable; settings still work for this session.
  }
}

export function resetTire() {
  Object.assign(TIRE, clone(DEFAULT_TIRE));
  saveTire();
}

// GPU tyre solver settings (see gpu-tire-solver.js). Geometry comes from TIRE.
export const DEFAULT_GPU_TIRE = Object.freeze({
  pressureKpa: 120, // gauge air pressure
  segmentsAround: 40,
  segmentsAcross: 10,
  beadRings: 1,
  substeps: 4,
  iterations: 8,
  cordStiffness: 1.0, // per Jacobi pass, 0..1
  shearStiffness: 1.0,
  bendStiffness: 0.6,
  shapeStiffness: 0.3, // pull toward the moulded shape per pass (across the tread)
  beadPull: 0.5, // fraction of the gap to the rim seat closed per pass
  damping: 2, // 1/s, relative to the wheel's rigid motion
  friction: 1.1,
  contactRadius: 0.02,
  relaxation: 1.0,
  pressureLead: 1.0, // substeps of spin the pressure normal is turned ahead (cancels spin drag)
  rubberMass: 12,
});

const GPU_STORAGE_KEY = 'drift.gputire.v1';
function loadGpu() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(GPU_STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}
export const GPU_TIRE = { ...DEFAULT_GPU_TIRE };
for (const [key, value] of Object.entries(loadGpu())) {
  if (typeof value === typeof DEFAULT_GPU_TIRE[key]) GPU_TIRE[key] = value;
}
export function saveGpuTire() {
  try {
    globalThis.localStorage?.setItem(GPU_STORAGE_KEY, JSON.stringify(GPU_TIRE));
  } catch {
    // Storage can be unavailable; settings still work for this session.
  }
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
export function effectiveGpuTire(gpu, performance, ground = GROUND) {
  // Loose soil grips less than firm ground.
  const withSoil = { ...gpu, soilStiffness: soilStiffness(ground.softness), friction: gpu.friction * (1 - 0.4 * ground.softness) };
  if (!performance) return withSoil;
  return { ...withSoil, substeps: Math.min(gpu.substeps, 3), iterations: Math.min(gpu.iterations, 6), segmentsAround: 32, segmentsAcross: 8 };
}

// Ground settings shared by the tyres and the track renderer.
export const DEFAULT_GROUND = Object.freeze({
  softness: 0.15, // 0 = hard, 1 = very soft soil
  tracks: true,
  trackLength: 1500, // segments kept per wheel
});
const GROUND_KEY = 'drift.ground.v1';
function loadGround() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(GROUND_KEY) ?? '{}');
  } catch {
    return {};
  }
}
export const GROUND = { ...DEFAULT_GROUND };
for (const [key, value] of Object.entries(loadGround())) {
  if (typeof value === typeof DEFAULT_GROUND[key]) GROUND[key] = value;
}
export function saveGround() {
  try {
    globalThis.localStorage?.setItem(GROUND_KEY, JSON.stringify(GROUND));
  } catch {
    // Storage can be unavailable; settings still work for this session.
  }
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
