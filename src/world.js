// Which world to drive in. The panel's world picker saves the choice and reloads the page;
// ?terrain=<mode> overrides it (tests use ?terrain=flat).
export const WORLDS = { 'Red-rock canyon': 'canyon', 'Dry river': 'river', Snowfield: 'snow' };
export const DEFAULT_WORLD = 'canyon';
const WORLD_KEY = 'drift.world';

export function savedWorld() {
  try {
    const saved = globalThis.localStorage?.getItem(WORLD_KEY);
    return Object.values(WORLDS).includes(saved) ? saved : DEFAULT_WORLD;
  } catch {
    return DEFAULT_WORLD;
  }
}

export function saveWorld(mode) {
  try {
    if (mode === DEFAULT_WORLD) globalThis.localStorage?.removeItem(WORLD_KEY);
    else globalThis.localStorage?.setItem(WORLD_KEY, mode);
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts only for the URL below.
  }
}

// The terrain mode for this page load.
export function worldMode(search = globalThis.location?.search ?? '') {
  return new URLSearchParams(search).get('terrain') ?? savedWorld();
}
