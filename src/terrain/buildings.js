// The dark town's buildings (terrain/town.js): houses, apartment blocks and towers lining the
// streets, each turned to face its street. They come from a fixed grid of lots, so every chunk (and
// every worker) agrees on them. A lot's building is dropped where it would overlap a neighbour
// with a higher priority, the street, the water or a steep slope, which leaves gardens and gaps.
//
// Each building is also a solid box for physics: it joins the chunk's rocks with its eight corners
// as `vertices` (the convex hull collider and the GPU tyres' rock planes use them) and no `faces`
// (the rock mesh skips it; render/building-mesh.js draws it from `building`).
import { CHUNK_SIZE } from './chunk.js';
import { KERB } from './town.js';
import { TOWN_KIT } from './town-kit.js';

const LOT = 13; // m between lot centres
const GAP = 0.8; // m kept between neighbouring buildings
// The sunny town is packed tighter, like the reference diorama: closer lots, buildings nearly
// touching, the front row on the building line right behind the sidewalk.
const KIT_LOT = 8;
const KIT_GAP = 0.15;
const lotSize = (heightAt) => (heightAt.buildingKit ? KIT_LOT : LOT);
const NARROW_KIT = 'Kit_Townhouse'; // tried where the lot's pick doesn't fit
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
  const lot = lotSize(heightAt);
  let x = (i + 0.5 + (r(1) - 0.5) * 0.3) * lot;
  let z = (j + 0.5 + (r(2) - 0.5) * 0.3) * lot;
  let s = heightAt.sample(x, z);
  const town = 1 - s.wild;
  if (heightAt.buildingKit ? r(3) > smoothstep(0.1, 0.4, town) : r(3) > 0.95 * smoothstep(0.15, 0.55, town)) return null;
  // The sunny town's streets are lined by rows (see `frontage`); its lots only fill in behind them.
  if (s.dist < (heightAt.buildingKit ? KERB + 13 : KERB + 1) || s.dist > 36 || s.townHill > 0.5) return null;
  if (s.riverDist < s.riverHalf + 9) return null;
  // Downtown (deep in town) builds taller and closer together.
  const core = smoothstep(0.6, 1, town) * (0.5 + 0.5 * Math.sin(x * 0.011 + 1.3) * Math.cos(z * 0.009 - 0.4));
  const tall = r(4) < 0.18 + 0.55 * core;
  const storeys = tall ? 3 + Math.floor(r(5) * (2 + 3 * core)) : 1 + Math.floor(r(5) * 2.5);
  // Width along the street, depth away from it.
  let w = 6.5 + r(6) * 5;
  let d = 7 + r(7) * 5;
  let roof;
  const pick = r(9);
  // Mostly pitched tile roofs, as in the reference; flat roofs on some of the blocks.
  if (tall) roof = pick < 0.06 ? 'spire' : pick < 0.14 ? 'dome' : pick < 0.42 ? 'hip' : pick < 0.62 ? 'gable' : 'flat';
  else roof = pick < 0.5 ? 'gable' : pick < 0.88 ? 'hip' : 'flat';
  // Spires and domes crown narrower towers.
  if (roof === 'spire' || roof === 'dome') {
    w = d = 7 + r(6) * 2;
  }
  // The building faces the street: its depth axis is the street's normal (gx, gz), pointing away.
  const sign = Math.sign(s.side) || 1;
  const nx = s.gx * sign;
  const nz = s.gz * sign;
  const ux = -nz; // along the street
  const uz = nx;
  const front = s.dist < 18 && !heightAt.buildingKit;
  // A w x d footprint on this lot, or null where it doesn't fit.
  const fit = (w, d, line) => {
    let px0 = x;
    let pz0 = z;
    // The first row stands on a building line just behind the sidewalk; further out they keep their lot.
    if (front) {
      const push = line + d / 2 - s.dist;
      px0 += nx * push;
      pz0 += nz * push;
    }
    const ground = footprintGround(heightAt, px0, pz0, ux, uz, nx, nz, w, d);
    return ground && { x: px0, z: pz0, w, d, ...ground };
  };
  let kit = null;
  let stretch = 1;
  let at;
  if (heightAt.buildingKit) {
    // The sunny town builds from the modelled kit (render/town-kit-mesh.js) at the models' own
    // size; straight-fronted ones may be widened or narrowed a little, so rows close up. Where the
    // pick doesn't fit (a bend in the street, the water), a narrower one is tried.
    const line = KERB + 0.5 + r(8) * 0.4;
    const first = pickKit(tall, r(15));
    const narrow = TOWN_KIT.find((k) => k.name === NARROW_KIT);
    const tries = [[first, first.stretch ? 0.9 + r(16) * 0.25 : 1]];
    if (first.stretch) tries.push([first, 0.85]);
    if (first !== narrow) tries.push([narrow, 1]);
    for (const [k, f] of tries) {
      at = fit(k.w * f, k.d, line);
      if (at) {
        kit = k;
        stretch = f;
        break;
      }
    }
    if (!at) return null;
    roof = 'kit';
  } else {
    at = fit(w, d, KERB + 1.2 + r(8) * 1.2);
    if (!at) return null;
  }
  ({ x, z, w, d } = at);
  const { lo, hi } = at;
  const yaw = Math.atan2(nz, nx); // the depth axis' direction in x/z
  const height = kit ? kit.eaves : storeys * FLOOR + 0.6;
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
    storeys: kit ? kit.storeys : storeys,
    roof,
    kit: kit ? kit.name : null,
    stretch,
    glass: !kit && tall && r(10) < 0.3,
    wall: r(11),
    roofColor: r(12),
    extra: r(13),
    radius: Math.hypot(w, d) / 2,
    priority: r(14),
    i,
    j,
  };
}

// Tall lots: mostly the big blocks, some three-storey houses, now and then a landmark (the domed
// tower, the glass block); low lots: mostly houses, some blocks and cottages. Per model.
const KIT_ODDS = {
  tall: { tall: 1, mid: 0.5, small: 0, rare: 0.03 },
  low: { tall: 0.5, mid: 1, small: 0.2, rare: 0.01 },
};
function pickKit(tall, t) {
  const odds = KIT_ODDS[tall ? 'tall' : 'low'];
  const weight = (k) => odds[k.size] ?? 0;
  const total = TOWN_KIT.reduce((sum, k) => sum + weight(k), 0);
  let left = t * total;
  for (const k of TOWN_KIT) {
    left -= weight(k);
    if (left < 0 && weight(k) > 0) return k;
  }
  return TOWN_KIT.findLast((k) => weight(k) > 0);
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
  const lot = lotSize(heightAt);
  const i0 = Math.floor((cx * CHUNK_SIZE) / lot) - 2;
  const i1 = Math.floor(((cx + 1) * CHUNK_SIZE) / lot) + 2;
  const j0 = Math.floor((cz * CHUNK_SIZE) / lot) - 2;
  const j1 = Math.floor(((cz + 1) * CHUNK_SIZE) / lot) + 2;
  const lots = [];
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const b = heightAt.buildingKit ? lotAt(heightAt, i, j) : lotBuilding(heightAt, i, j);
    if (b) lots.push(b);
  }
  if (heightAt.buildingKit) lots.push(...frontageNear(heightAt, (cx + 0.5) * CHUNK_SIZE, (cz + 0.5) * CHUNK_SIZE, CHUNK_SIZE));
  const buildings = [];
  for (const b of lots) {
    if (Math.floor(b.x / CHUNK_SIZE) !== cx || Math.floor(b.z / CHUNK_SIZE) !== cz) continue;
    // Pushed out to the building line, a building can reach over the neighbouring lots: the one with
    // the higher priority stays.
    // The sunny town only gives way to neighbours that are built themselves, which leaves
    // fewer gaps in its rows.
    const blocked = heightAt.buildingKit ? !survives(heightAt, b) : lots.some((o) => o !== b && o.priority > b.priority && overlap(o, b, GAP));
    if (!blocked) buildings.push(toRock(b));
  }
  cache.set(key, { heightAt, buildings });
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return buildings;
}

// The sunny town's lots, kept by heightAt and lot (any chunk or worker gets the same answer).
const lotCache = new WeakMap();
function lotAt(heightAt, i, j) {
  let lots = lotCache.get(heightAt);
  if (!lots || lots.size > 50000) lotCache.set(heightAt, (lots = new Map()));
  const key = `${i},${j}`;
  if (!lots.has(key)) lots.set(key, lotBuilding(heightAt, i, j));
  return lots.get(key);
}
const REACH = 3; // lots around a point whose building can reach it

// Whether a lot's building is built: none of its higher-priority neighbours that overlap it is.
// (Priorities fall along every chain of overlaps, so this ends.)
function survives(heightAt, b) {
  if (b.survives !== undefined) return b.survives;
  let ok = true;
  for (const o of neighbours(heightAt, b)) {
    if (o !== b && o.priority > b.priority && overlap(o, b, KIT_GAP) && survives(heightAt, o)) {
      ok = false;
      break;
    }
  }
  b.survives = ok;
  return ok;
}

// The sunny town's buildings that might touch b: the street rows' near it and the lots around it.
function neighbours(heightAt, b) {
  const out = frontageNear(heightAt, b.x, b.z, b.radius + 14);
  const lot = KIT_LOT;
  const i0 = Math.floor(b.x / lot);
  const j0 = Math.floor(b.z / lot);
  for (let dj = -REACH; dj <= REACH; dj++) {
    for (let di = -REACH; di <= REACH; di++) {
      const o = lotAt(heightAt, i0 + di, j0 + dj);
      if (o) out.push(o);
    }
  }
  return out;
}

// The ground under a footprint (lowest and highest), or null where it would stand on a street's
// sidewalk, in the water, in the mountains or on a steep slope.
function footprintGround(heightAt, x, z, ux, uz, nx, nz, w, d) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0], [0, 0]]) {
    const ps = heightAt.sample(x + ux * a * w * 0.5 + nx * b * d * 0.5, z + uz * a * w * 0.5 + nz * b * d * 0.5);
    if (ps.dist < KERB + 0.4 || ps.riverDist < ps.riverHalf + 4) return null;
    if (ps.h < 0.6 || ps.mountain > 3) return null;
    lo = Math.min(lo, ps.h);
    hi = Math.max(hi, ps.h);
  }
  return hi - lo > 3.5 ? null : { lo, hi };
}

// ---- The sunny town's street rows ----------------------------------------------------------------
// Each side of each street is cut into segments of SEG m (along x or z, as the street runs); a
// segment is filled from its start with kit buildings side by side on the building line, facing the
// street, like the reference's continuous frontages. A segment depends only on its street, side and
// number, so every chunk and worker builds the same rows.
const SEG = 64;
const LINE = KERB + 0.6; // m from the centre line to the fronts
const segments = new WeakMap();

// The centre line of street k of family f at `t` along it (x or z), with its unit normal (toward
// growing `across`): Newton steps on the family's field.
function streetPoint(f, k, t) {
  const target = k * f.spacing;
  let v = target;
  const at = (v) => (f.alongX ? f.across(t, v) : f.across(v, t));
  for (let it = 0; it < 12; it++) {
    const g = at(v) - target;
    if (Math.abs(g) < 1e-3) break;
    const dg = at(v + 0.5) - at(v - 0.5);
    // The field rises across the streets (its slope near 1); a step that would run off is clamped.
    v -= Math.max(-20, Math.min(20, g / (dg > 0.2 ? dg : 1)));
  }
  if (Math.abs(at(v) - target) > 0.05) return null;
  const x = f.alongX ? t : v;
  const z = f.alongX ? v : t;
  const e = 0.5;
  const gx = (f.across(x + e, z) - f.across(x - e, z)) / (2 * e);
  const gz = (f.across(x, z + e) - f.across(x, z - e)) / (2 * e);
  const g = Math.hypot(gx, gz) || 1;
  return { x, z, gx: gx / g, gz: gz / g };
}

function segment(heightAt, fi, k, m, side) {
  let cache = segments.get(heightAt);
  if (!cache || cache.size > 20000) segments.set(heightAt, (cache = new Map()));
  const key = `${fi},${k},${m},${side}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const f = heightAt.streetFamilies[fi];
  const r = (q) => hash(k * 4 + fi * 2 + (side > 0 ? 1 : 0), m, q);
  const narrow = TOWN_KIT.find((kk) => kk.name === NARROW_KIT);
  const out = [];
  const t1 = (m + 1) * SEG;
  let t = m * SEG + r(1) * 2;
  for (let n = 0; n < 24 && t < t1 - 3; n++) {
    const p = streetPoint(f, k, t);
    const q = p && streetPoint(f, k, t + 1);
    if (!q) {
      t += 6;
      continue;
    }
    const s = heightAt.sample(p.x, p.z);
    // How far along the street one unit of t goes, here.
    const speed = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    const town = 1 - s.wild;
    if (r(100 + n) > smoothstep(0.15, 0.45, town)) {
      t += 6 / speed;
      continue;
    }
    // Downtown (deep in town) builds taller.
    const core = smoothstep(0.6, 1, town) * (0.5 + 0.5 * Math.sin(p.x * 0.011 + 1.3) * Math.cos(p.z * 0.009 - 0.4));
    const tall = r(200 + n) < 0.3 + 0.6 * core;
    const first = pickKit(tall, r(300 + n));
    let placed = null;
    for (const kit of first === narrow ? [first] : [first, narrow]) {
      const w = kit.w * (kit.stretch ? 0.9 + 0.25 * r(400 + n) : 1);
      const dt = w / speed;
      if (t + dt > t1) continue;
      placed = place(heightAt, f, k, side, t + dt / 2, kit, w, r(500 + n));
      // On the inside of a bend the backs close in on the previous building: slide along.
      for (let nudge = 0; placed && out.length && overlap(out[out.length - 1], placed, KIT_GAP) && nudge < 8; nudge++) {
        t += 0.6 / speed;
        placed = t + dt <= t1 ? place(heightAt, f, k, side, t + dt / 2, kit, w, r(500 + n)) : null;
      }
      if (placed && out.length && overlap(out[out.length - 1], placed, KIT_GAP)) placed = null;
      if (placed) {
        t += dt + KIT_GAP / speed;
        break;
      }
    }
    if (placed) out.push(placed);
    else t += 3 / speed; // a gap: a corner, a bend, the water
  }
  cache.set(key, out);
  return out;
}

// A kit building in a street row, centred at `t`, or null where it doesn't fit.
function place(heightAt, f, k, side, t, kit, w, seed) {
  const p = streetPoint(f, k, t);
  if (!p) return null;
  const nx = p.gx * side;
  const nz = p.gz * side;
  const ux = -nz;
  const uz = nx;
  const d = kit.d;
  let x = p.x + nx * (LINE + d / 2);
  let z = p.z + nz * (LINE + d / 2);
  // On a bend the front corners come closer to the street (or another street near a corner):
  // set the building back until they clear the sidewalk.
  let back = 0;
  for (const a of [-1, 0, 1]) {
    const c = heightAt.sample(x + ux * a * w * 0.5 - nx * d * 0.5, z + uz * a * w * 0.5 - nz * d * 0.5);
    back = Math.max(back, KERB + 0.5 - c.dist);
  }
  if (back > 3) return null;
  x += nx * back;
  z += nz * back;
  // It must face its own street (not another one it ended up next to).
  const front = heightAt.sample(x - nx * d * 0.5, z - nz * d * 0.5);
  if (front.dist > LINE + back + 1.5) return null;
  const ground = footprintGround(heightAt, x, z, ux, uz, nx, nz, w, d);
  if (!ground) return null;
  const r = (q) => hash(Math.floor(seed * 1e6), q, 77);
  return {
    x,
    z,
    w,
    d,
    ux,
    uz,
    nx,
    nz,
    yaw: Math.atan2(nz, nx),
    base: ground.lo - 1,
    ground: ground.hi,
    height: kit.eaves,
    storeys: kit.storeys,
    roof: 'kit',
    kit: kit.name,
    stretch: w / kit.w,
    glass: false,
    wall: r(1),
    roofColor: r(2),
    extra: r(3),
    radius: Math.hypot(w, d) / 2,
    // The rows go before the lots behind them.
    priority: 1 + seed,
  };
}

// The street rows' buildings within `radius` of a point (by their segments).
function frontageNear(heightAt, x, z, radius) {
  const out = [];
  const reach = radius + 20;
  heightAt.streetFamilies.forEach((f, fi) => {
    const a = f.across(x, z);
    const t = f.alongX ? x : z;
    for (let k = Math.floor((a - reach) / f.spacing); k <= Math.ceil((a + reach) / f.spacing); k++) {
      for (let m = Math.floor((t - reach) / SEG); m <= Math.floor((t + reach) / SEG); m++) {
        for (const side of [-1, 1]) {
          for (const b of segment(heightAt, fi, k, m, side)) if (Math.abs(b.x - x) < radius + b.radius && Math.abs(b.z - z) < radius + b.radius) out.push(b);
        }
      }
    }
  });
  return out;
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
