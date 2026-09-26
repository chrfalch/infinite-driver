import { loadSettings, saveSettings } from './settings-store.js';

// Driver preferences, persisted separately from the car setup.
const STORAGE_KEY = 'drift.controls.v1';

export const DEFAULT_CONTROLS = Object.freeze({
  // false: hold the accelerator to drive, release for engine braking.
  // true: tap once to latch the engine on, tap again to switch it off.
  latchAccelerator: false,
  // Cheaper tyre simulation: fewer solver passes and a coarser mesh.
  performance: false,
});

const load = () => loadSettings(STORAGE_KEY);

export const CONTROLS = { ...DEFAULT_CONTROLS };
for (const [key, value] of Object.entries(load())) {
  if (typeof value === typeof DEFAULT_CONTROLS[key]) CONTROLS[key] = value;
}

export function saveControls() {
  saveSettings(STORAGE_KEY, DEFAULT_CONTROLS, CONTROLS);
}
