// Driver preferences, persisted separately from the car setup.
const STORAGE_KEY = 'drift.controls.v1';

export const DEFAULT_CONTROLS = Object.freeze({
  // false: hold the accelerator to drive, release for engine braking.
  // true: tap once to latch the engine on, tap again to switch it off.
  latchAccelerator: false,
});

function load() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export const CONTROLS = { ...DEFAULT_CONTROLS };
for (const [key, value] of Object.entries(load())) {
  if (typeof value === typeof DEFAULT_CONTROLS[key]) CONTROLS[key] = value;
}

export function saveControls() {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(CONTROLS));
  } catch {
    // Storage can be unavailable; the setting still works for this session.
  }
}
