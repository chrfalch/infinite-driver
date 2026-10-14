// Which world to drive in. The panel's world picker saves the choice and reloads the page;
// ?terrain=<mode> overrides it (tests use ?terrain=flat).
export const WORLDS = { 'Red-rock canyon': 'canyon', 'Dry river': 'river', Snowfield: 'snow', 'Dark town': 'town', 'Sunny town': 'daytown' };
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

// The page for a newly picked world: saved, and without ?terrain (which would override it).
// A new world needs a fresh start (both workers build their terrain at load).
export function switchWorld(mode, href = globalThis.location.href) {
  saveWorld(mode);
  const url = new URL(href);
  url.searchParams.delete('terrain');
  return url.href;
}
