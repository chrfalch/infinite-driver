import { loadSettings, saveSettings } from './settings-store.js';

// Driver preferences, persisted separately from the car setup.
const STORAGE_KEY = 'drift.controls.v1';

export const DEFAULT_CONTROLS = Object.freeze({
  // false: hold the accelerator to drive, release for engine braking.
  // true: tap once to latch the engine on, tap again to switch it off.
  latchAccelerator: false,
  // Seconds the accelerator takes to open the throttle fully (0 = at once). Shift locks it.
  throttleRamp: 0.8,
  // Cheaper tyre simulation: fewer solver passes and a coarser mesh.
  performance: false,
  // Graphics quality: 'auto', 'high', or 'low'. See render/quality.js.
  graphics: 'auto',
  // Depth of field: the car sharp, the world behind it blurring with distance (render/depth-of-field.js).
  depthOfField: true,
  // Metres behind the car to full blur, and the blur's size (0 = none).
  dofRange: 35,
  dofStrength: 3,
  // Metres in front of the car to full blur (0 = the near side stays sharp).
  dofNear: 0,
  // One slider over the three above, from the far-only blur (0) to a macro-narrow focus plane (1);
  // see focusPlane.
  dofFocus: 0,
  // Physics and renderer stats on the dashboard (P toggles).
  showPerf: false,
});

// The depth-of-field settings for a focus plane from 0 (blur only far behind the car: 35 m to full,
// strength 3, near side sharp) to 1 (5 m to full blur either side, strength 5). The ranges move
// in 1/metres, so the near blur comes in gradually from "infinitely far" and the far range
// narrows evenly; halfway is about 9 m behind, 10 m in front, strength 4.
const WIDE = { far: 35, strength: 3 };
const NARROW = { far: 5, near: 5, strength: 5 };
export function focusPlane(t) {
  const k = Math.min(1, Math.max(0, t));
  const lerp = (a, b) => a + (b - a) * k;
  const round = (n, step) => Math.round(n / step) * step;
  return {
    dofRange: round(1 / lerp(1 / WIDE.far, 1 / NARROW.far), 0.1),
    dofStrength: round(lerp(WIDE.strength, NARROW.strength), 0.1),
    dofNear: k > 0 ? round(1 / lerp(0, 1 / NARROW.near), 0.1) : 0,
  };
}

const load = () => loadSettings(STORAGE_KEY);

export const CONTROLS = { ...DEFAULT_CONTROLS };
for (const [key, value] of Object.entries(load())) {
  if (typeof value === typeof DEFAULT_CONTROLS[key]) CONTROLS[key] = value;
}

export function saveControls() {
  saveSettings(STORAGE_KEY, DEFAULT_CONTROLS, CONTROLS);
}
