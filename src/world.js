// Which world to drive in. The loading screen asks first (start.js) and saves the pick; the panel's
// picker saves it and reloads the page into it; ?terrain=<mode> overrides it (tests use ?terrain=flat).
export const WORLDS = { 'Red-rock canyon': 'canyon', 'Dry river': 'river', Snowfield: 'snow', 'Sunny town': 'daytown' };
export const DEFAULT_WORLD = 'canyon';
const WORLD_KEY = 'drift.world';
// The world just picked, for the page load it reloads into (this tab only).
const PICKED_KEY = 'drift.picked';

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

function pickedWorld() {
  try {
    const picked = globalThis.sessionStorage?.getItem(PICKED_KEY);
    return Object.values(WORLDS).includes(picked) ? picked : null;
  } catch {
    return null;
  }
}

// The terrain mode for this page load.
export function worldMode(search = globalThis.location?.search ?? '') {
  return new URLSearchParams(search).get('terrain') ?? pickedWorld() ?? savedWorld();
}

// The world already chosen for this page load (?terrain, or a pick that reloaded into it), or null
// when the loading screen should ask. Called once at startup: the pick is used up, so reloading the
// page asks again.
export function chosenWorld(search = globalThis.location?.search ?? '') {
  const chosen = new URLSearchParams(search).has('terrain') || pickedWorld() ? worldMode(search) : null;
  try {
    globalThis.sessionStorage?.removeItem(PICKED_KEY);
  } catch {
    // Nothing was saved then.
  }
  return chosen;
}

// A world picked on the loading screen, before the game's modules load: this page load is in it.
export function pickWorld(mode) {
  saveWorld(mode);
  if (worldMode() === mode) return;
  // Without storage, or under another ?terrain: the URL says it.
  const url = new URL(globalThis.location.href);
  url.searchParams.set('terrain', mode);
  globalThis.history.replaceState(globalThis.history.state, '', url);
}

// The page for a newly picked world: saved, and without ?terrain (which would override it).
// A new world needs a fresh start (both workers build their terrain at load).
export function switchWorld(mode, href = globalThis.location.href) {
  saveWorld(mode);
  const url = new URL(href);
  url.searchParams.delete('terrain');
  try {
    globalThis.sessionStorage.setItem(PICKED_KEY, mode);
  } catch {
    // Without session storage the pick goes in the URL instead.
    url.searchParams.set('terrain', mode);
  }
  return url.href;
}
