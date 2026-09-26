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
