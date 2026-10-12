// The isometric town's buildings (terrain/town.js): houses, apartment blocks and towers lining the
// streets, each turned to face its street. They come from a fixed grid of lots, so every chunk (and
// every worker) agrees on them. A lot's building is dropped where it would overlap a neighbour
// with a higher priority, the street, the water or a steep slope, which leaves gardens and gaps.
//
// Each building is also a solid box for physics: it joins the chunk's rocks with its eight corners
// as `vertices` (the convex hull collider and the GPU tyres' rock planes use them) and no `faces`
// (the rock mesh skips it; render/building-mesh.js draws it from `building`).
import { CHUNK_SIZE } from './chunk.js';
import { KERB } from './town.js';

const LOT = 13; // m between lot centres
const GAP = 0.8; // m kept between neighbouring buildings
const FLOOR = 3.2; // m per storey

function hash(ix, iz, k) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(k, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Wall and roof colours, picked per building (from the reference diorama: cream and sand stone,
// terracotta and brick, pale yellow, white and grey render, a turquoise block; terracotta, slate and
// brown roofs, the odd teal one).
export const WALLS = ['#ecdfc3', '#dcc092', '#e8d48e', '#c96f4a', '#b45a3e', '#efeae0', '#c8c3b8', '#d9a86c', '#a88466', '#e6c7a4'];
export const GLASS_WALLS = ['#56b6c9', '#4ea4c6', '#6cc0cf'];
export const ROOFS = ['#c4583b', '#d26a42', '#b04a32', '#5c6068', '#4b4e54', '#6b5040', '#4a9db0'];

// The building on lot (i, j), before checking its neighbours, or null.
function lotBuilding(heightAt, i, j) {
  const r = (k) => hash(i, j, k);
  let x = (i + 0.5 + (r(1) - 0.5) * 0.3) * LOT;
  let z = (j + 0.5 + (r(2) - 0.5) * 0.3) * LOT;
  let s = heightAt.sample(x, z);
  const town = 1 - s.wild;
  if (r(3) > 0.95 * smoothstep(0.15, 0.55, town)) return null;
  if (s.dist < KERB + 1 || s.dist > 36 || s.townHill > 0.5) return null;
  if (s.riverDist < s.riverHalf + 9) return null;
  // Downtown (deep in town) builds taller and closer together.
  const core = smoothstep(0.6, 1, town) * (0.5 + 0.5 * Math.sin(x * 0.011 + 1.3) * Math.cos(z * 0.009 - 0.4));
  const tall = r(4) < 0.18 + 0.55 * core;
  const storeys = tall ? 3 + Math.floor(r(5) * (2 + 3 * core)) : 1 + Math.floor(r(5) * 2.5);
  // Width along the street, depth away from it.
  let w = 6.5 + r(6) * 5;
  let d = 7 + r(7) * 5;
  // The building faces the street: its depth axis is the street's normal (gx, gz), pointing away.
  const sign = Math.sign(s.side) || 1;
  const nx = s.gx * sign;
  const nz = s.gz * sign;
  // The first row stands on a building line just behind the sidewalk; further out they keep their lot.
  if (s.dist < 18) {
    const push = KERB + 1.2 + r(8) * 1.2 + d / 2 - s.dist;
    x += nx * push;
    z += nz * push;
    s = heightAt.sample(x, z);
  }
  let roof;
  const pick = r(9);
  // Mostly pitched tile roofs, as in the reference; flat roofs on some of the blocks.
  if (tall) roof = pick < 0.06 ? 'spire' : pick < 0.14 ? 'dome' : pick < 0.42 ? 'hip' : pick < 0.62 ? 'gable' : 'flat';
  else roof = pick < 0.5 ? 'gable' : pick < 0.88 ? 'hip' : 'flat';
  // Spires and domes crown narrower towers.
  if (roof === 'spire' || roof === 'dome') {
    w = d = 7 + r(6) * 2;
  }
  const yaw = Math.atan2(nz, nx); // the depth axis' direction in x/z
  const ux = -nz; // along the street
  const uz = nx;
  // The footprint must keep off every street's sidewalk and out of the water, on fairly even ground.
  let lo = Infinity;
  let hi = -Infinity;
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0], [0, 0]]) {
    const px = x + ux * a * w * 0.5 + nx * b * d * 0.5;
    const pz = z + uz * a * w * 0.5 + nz * b * d * 0.5;
    const ps = heightAt.sample(px, pz);
    if (ps.dist < KERB + 0.4 || ps.riverDist < ps.riverHalf + 4) return null;
    if (ps.h < 0.6 || ps.mountain > 3) return null;
    lo = Math.min(lo, ps.h);
    hi = Math.max(hi, ps.h);
  }
  if (hi - lo > 3.5) return null;
  const height = storeys * FLOOR + 0.6;
  return {
    x,
    z,
    w,
    d,
    ux,
    uz,
    nx,
    nz,
    yaw,
    base: lo - 1,
    ground: hi,
    height,
    storeys,
    roof,
    glass: tall && r(10) < 0.3,
    wall: r(11),
    roofColor: r(12),
    extra: r(13),
    radius: Math.hypot(w, d) / 2,
    priority: r(14),
  };
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// A few chunks' buildings, kept so the plants and rocks of the same chunk (built right after, in
// the same worker) can keep out of them without placing them again.
const cache = new Map();
const CACHE_SIZE = 24;

// The buildings standing in one chunk (by their centre), as rock entries (see the top).
export function generateBuildings(heightAt, cx, cz) {
  if (!heightAt.town) return [];
  const key = `${cx},${cz}`;
  const hit = cache.get(key);
  if (hit && hit.heightAt === heightAt) return hit.buildings;
  // Lots whose building may stand in this chunk, and the ring around them it may collide with.
  const i0 = Math.floor((cx * CHUNK_SIZE) / LOT) - 2;
  const i1 = Math.floor(((cx + 1) * CHUNK_SIZE) / LOT) + 2;
  const j0 = Math.floor((cz * CHUNK_SIZE) / LOT) - 2;
  const j1 = Math.floor(((cz + 1) * CHUNK_SIZE) / LOT) + 2;
  const lots = [];
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const b = lotBuilding(heightAt, i, j);
    if (b) lots.push(b);
  }
  const buildings = [];
  for (const b of lots) {
    if (Math.floor(b.x / CHUNK_SIZE) !== cx || Math.floor(b.z / CHUNK_SIZE) !== cz) continue;
    // Pushed out to the building line, a building can reach over the neighbouring lots: the one with
    // the higher priority stays.
    const blocked = lots.some((o) => o !== b && o.priority > b.priority && overlap(o, b, GAP));
    if (!blocked) buildings.push(toRock(b));
  }
  cache.set(key, { heightAt, buildings });
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return buildings;
}

// Whether two footprints (turned rectangles) come closer than `gap`: separating axis test on the
// four edge directions.
function overlap(a, b, gap) {
  if (Math.hypot(a.x - b.x, a.z - b.z) > a.radius + b.radius + gap) return false;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  for (const [ax, az] of [[a.ux, a.uz], [a.nx, a.nz], [b.ux, b.uz], [b.nx, b.nz]]) {
    const reach = (r) => (Math.abs(r.ux * ax + r.uz * az) * r.w + Math.abs(r.nx * ax + r.nz * az) * r.d) / 2;
    if (Math.abs(dx * ax + dz * az) >= reach(a) + reach(b) + gap) return false;
  }
  return true;
}

// The building's body as a box: its eight corners, base to eaves.
function toRock(b) {
  const vertices = new Float32Array(24);
  const top = b.ground + b.height;
  let k = 0;
  for (const y of [b.base, top]) {
    for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      vertices[k++] = b.x + b.ux * a * b.w * 0.5 + b.nx * c * b.d * 0.5;
      vertices[k++] = y;
      vertices[k++] = b.z + b.uz * a * b.w * 0.5 + b.nz * c * b.d * 0.5;
    }
  }
  return { x: b.x, z: b.z, size: b.radius, vertices, faces: [], building: b };
}

// The buildings of a chunk and its eight neighbours (a building can reach over a chunk's edge).
export function buildingsAround(heightAt, cx, cz) {
  const out = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) out.push(...generateBuildings(heightAt, cx + dx, cz + dz));
  return out;
}

// Whether a point lies within `margin` of a building's footprint.
export function insideBuilding(buildings, x, z, margin = 0) {
  for (const { building: b } of buildings) {
    const dx = x - b.x;
    const dz = z - b.z;
    if (dx * dx + dz * dz > (b.radius + margin) ** 2) continue;
    if (Math.abs(dx * b.ux + dz * b.uz) < b.w / 2 + margin && Math.abs(dx * b.nx + dz * b.nz) < b.d / 2 + margin) return true;
  }
  return false;
}
