// The cars on the road besides the player's: each runs its own tyre model (see TIRE_MODES), so
// a GPU-tyred player can share the road with rigid-wheeled cars that cost next to nothing.
//
// ?rivals=rigid,gpu adds one car per entry, `mode[:livery]` (e.g. ?rivals=rigid:red,gpu:yellow).
// The cars line up behind the player's at the start (see gridSlot) and stand still until something
// drives them through their Vehicle's `input` (see systems/physics.js).
import { TIRE_MODES } from './config.js';

// Liveries the other cars take in turn when none is given (see LIVERIES in render/trophy-body.js).
export const RIVAL_LIVERIES = ['red', 'yellow', 'black', 'white'];
// At most this many cars besides the player's.
export const MAX_RIVALS = 7;

// The other cars from a ?rivals= value: [{ tires, livery }]. Unknown tyre models are skipped.
export function parseRivals(value) {
  if (!value) return [];
  const rivals = [];
  for (const entry of value.split(',')) {
    const [mode, livery] = entry.trim().toLowerCase().split(':');
    if (!TIRE_MODES.includes(mode)) continue;
    rivals.push({ tires: mode, livery: livery || RIVAL_LIVERIES[rivals.length % RIVAL_LIVERIES.length] });
    if (rivals.length >= MAX_RIVALS) break;
  }
  return rivals;
}

// The other cars this page asked for.
export function configuredRivals(search = globalThis.location?.search ?? '') {
  return parseRivals(new URLSearchParams(search).get('rivals'));
}

// Grid slot `n` (1, 2, … behind the car at slot 0) for a car starting at (x, z) facing `yaw`:
// in single file (the dry river narrows to under 3 m), staggered a little left and right of the
// line, a car length and a bit apart.
const ROW = 6.5; // m between cars (they are 5 m long)
const SIDE = 0.8; // m either side of the line
export function gridSlot(x, z, yaw, n) {
  const back = n * ROW;
  const side = n === 0 ? 0 : n % 2 ? -SIDE : SIDE;
  // Forward (cos, -sin) for a yaw about +y; its right (sin, cos).
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: x - back * c + side * s, z: z + back * s + side * c, yaw };
}
