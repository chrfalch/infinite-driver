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

// Tall lots: mostly the big blocks, some three-storey houses, very rarely the domed tower or the
// glass block; low lots: mostly houses, some blocks and cottages. Per model. (The landmarks and
// fountains have their own spots, see `landmarkAt` and `plazaAt`.)
const KIT_ODDS = {
  tall: { tall: 0.6, mid: 1, small: 0.3, rare: 0.02 },
  low: { tall: 0.15, mid: 1, small: 0.8, rare: 0 },
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
  if (heightAt.buildingKit) {
    const mx = (cx + 0.5) * CHUNK_SIZE;
    const mz = (cz + 0.5) * CHUNK_SIZE;
    lots.push(...frontageNear(heightAt, mx, mz, CHUNK_SIZE), ...specialsNear(heightAt, mx, mz, CHUNK_SIZE));
  }
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
  const out = [...frontageNear(heightAt, b.x, b.z, b.radius + 14), ...specialsNear(heightAt, b.x, b.z, b.radius + 14)];
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
    // (Nor across a driveway up onto the block, or in a stunt park.)
    if (ps.dist < KERB + 0.4 || ps.riverDist < ps.riverHalf + 4 || ps.park > 0.05 || ps.driveway > 0.05) return null;
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
const HOUSE_GAP = 3; // m between neighbouring houses in a row, at least
const HOUSE_GAP_SPREAD = 5; // m more, at most
const BEHIND_SHARE = 0.15; // of the row's buildings with another behind
const LINE = KERB + 0.6; // m from the centre line to the fronts
const segments = new WeakMap();

// The centre line of street k of family f at `t` along it (x or z), with its unit normal (toward
// growing `across`): Newton steps on the family's field.
export function streetPoint(f, k, t) {
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
  const back = [];
  const t1 = (m + 1) * SEG;
  let t = m * SEG + r(1) * 2;
  const mid = streetPoint(f, k, t + SEG / 2);
  const obstacles = mid ? specialsNear(heightAt, mid.x, mid.z, SEG) : [];
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
      // On the inside of a bend the backs close in on the previous building, and the corner
      // buildings, plazas and landmarks go first: slide along until clear.
      const blocked = (p) => (out.length && overlap(out[out.length - 1], p, KIT_GAP)) || obstacles.some((o) => overlap(o, p, KIT_GAP));
      for (let nudge = 0; placed && blocked(placed) && nudge < 30; nudge++) {
        t += 0.6 / speed;
        placed = t + dt <= t1 ? place(heightAt, f, k, side, t + dt / 2, kit, w, r(500 + n)) : null;
      }
      if (placed && blocked(placed)) placed = null;
      if (placed) {
        // Detached houses: a garden gap of a few metres to the next one.
        t += dt + (HOUSE_GAP + r(900 + n) * HOUSE_GAP_SPREAD) / speed;
        break;
      }
    }
    if (placed) {
      out.push(placed);
      // Now and then a second building behind it (a workshop, a back house).
      if (r(600 + n) < BEHIND_SHARE) {
        const behind = placeBehind(heightAt, placed, pickKit(tall, r(700 + n)), r(800 + n));
        if (behind && !(back.length && overlap(back[back.length - 1], behind, KIT_GAP)) && !obstacles.some((o) => overlap(o, behind, KIT_GAP))) back.push(behind);
      }
    } else t += 3 / speed; // a gap: a corner, a bend, the water
  }
  out.push(...back);
  cache.set(key, out);
  return out;
}

// A kit building in a row's second line, right behind `front` and facing the same way (narrow
// enough not to stick out much past it), or null where it doesn't fit.
function placeBehind(heightAt, front, pick, seed) {
  const narrow = TOWN_KIT.find((k) => k.name === NARROW_KIT);
  for (const kit of [pick, narrow]) {
    // As wide as the front one where it can stretch to it, or at most a little wider.
    const w = kit.stretch ? Math.min(kit.w * 1.15, Math.max(kit.w * 0.85, front.w)) : kit.w;
    if (w > front.w + 3) continue;
    const b = behindAt(heightAt, front, kit, w, seed);
    if (b) return b;
  }
  return null;
}

function behindAt(heightAt, front, kit, w, seed) {
  const gap = 1.2;
  const x = front.x + front.nx * (front.d / 2 + gap + kit.d / 2);
  const z = front.z + front.nz * (front.d / 2 + gap + kit.d / 2);
  const ground = footprintGround(heightAt, x, z, front.ux, front.uz, front.nx, front.nz, w, kit.d);
  if (!ground) return null;
  // Behind the rows, ahead of the lots.
  return kitBuilding(kit, x, z, w, front.nx, front.nz, ground, seed, 0.99 + seed * 0.009);
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
  // The rows go before the lots behind them.
  return kitBuilding(kit, x, z, w, nx, nz, ground, seed, 1 + seed);
}

function kitBuilding(kit, x, z, w, nx, nz, ground, seed, priority) {
  const r = (q) => hash(Math.floor(seed * 1e6), q, 77);
  const d = kit.d;
  return {
    x,
    z,
    w,
    d,
    ux: -nz,
    uz: nx,
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
    priority,
  };
}

// ---- Landmarks and plazas --------------------------------------------------------------------
// One landmark at most in each LANDMARK_CELL square (a clock tower, the lattice tower, the domed
// tower or the glass block), on the street nearest a spot in it; and a fountain on a paved plaza
// at the corner of some junctions. Both go before the rows, which close up around them.
const LANDMARK_CELL = 260;
const LANDMARKS = ['Kit_ClockTower', 'Kit_LatticeTower', 'Kit_DomeTower', 'Kit_ClockTower', 'Kit_GlassBlock'];
const PLAZA_CLEAR = 17; // m: the fountain's paved plaza, kept clear of buildings
const specials = new WeakMap();

function landmarkAt(heightAt, ci, cj) {
  const r = (q) => hash(ci + 7001, cj - 3001, q);
  if (r(1) < 0.25) return null;
  const sx = (ci + 0.2 + 0.6 * r(2)) * LANDMARK_CELL;
  const sz = (cj + 0.2 + 0.6 * r(3)) * LANDMARK_CELL;
  const s = heightAt.sample(sx, sz);
  if (s.wild > 0.3 || s.dist > 70) return null;
  const kit = TOWN_KIT.find((k) => k.name === LANDMARKS[Math.floor(r(4) * LANDMARKS.length)]);
  // On the building line of the nearest street, facing it.
  const sign = Math.sign(s.side) || 1;
  const nx = s.gx * sign;
  const nz = s.gz * sign;
  const px = sx - s.gx * s.side;
  const pz = sz - s.gz * s.side;
  const x = px + nx * (LINE + 0.5 + kit.d / 2);
  const z = pz + nz * (LINE + 0.5 + kit.d / 2);
  const ground = footprintGround(heightAt, x, z, -nz, nx, nx, nz, kit.w, kit.d);
  return ground && kitBuilding(kit, x, z, kit.w, nx, nz, ground, r(5), 5 + r(6));
}

// Where the east-west family's field is a0 and the north-south one's a1 (a junction of streets
// k0 and k1 at a0 = k0 spacing0, a1 = k1 spacing1): Newton steps on both fields.
export function crossing(heightAt, a0, a1, x = a1, z = a0) {
  const [f0, f1] = heightAt.streetFamilies;
  for (let it = 0; it < 16; it++) {
    const a = f0.across(x, z) - a0;
    const b = f1.across(x, z) - a1;
    if (Math.abs(a) + Math.abs(b) < 1e-3) break;
    const e = 0.5;
    const ax = (f0.across(x + e, z) - f0.across(x - e, z)) / (2 * e);
    const az = (f0.across(x, z + e) - f0.across(x, z - e)) / (2 * e);
    const bx = (f1.across(x + e, z) - f1.across(x - e, z)) / (2 * e);
    const bz = (f1.across(x, z + e) - f1.across(x, z - e)) / (2 * e);
    const det = ax * bz - az * bx || 1;
    x -= Math.max(-30, Math.min(30, (a * bz - b * az) / det));
    z -= Math.max(-30, Math.min(30, (b * ax - a * bx) / det));
  }
  const ok = Math.abs(f0.across(x, z) - a0) < 0.05 && Math.abs(f1.across(x, z) - a1) < 0.05;
  return ok ? { x, z } : null;
}

// The point near junction j (of streets k0, k1) that is o0 m from street k0 and o1 m from street
// k1 (signed: toward growing `across`). The fields' slopes change away from the junction, so it is
// re-solved with the slopes found there.
function offsetFromJunction(heightAt, k0, k1, j, o0, o1) {
  const [f0, f1] = heightAt.streetFamilies;
  const slope = (f, p) => Math.hypot(f.across(p.x + 0.5, p.z) - f.across(p.x - 0.5, p.z), f.across(p.x, p.z + 0.5) - f.across(p.x, p.z - 0.5));
  let c = { x: j.x, z: j.z };
  for (let it = 0; it < 3 && c; it++) c = crossing(heightAt, k0 * f0.spacing + o0 * slope(f0, c), k1 * f1.spacing + o1 * slope(f1, c), c.x, c.z);
  return c;
}

// The unit normal of family f's streets at a point (toward growing `across`).
function streetNormal(f, x, z) {
  const gx = f.across(x + 0.5, z) - f.across(x - 0.5, z);
  const gz = f.across(x, z + 0.5) - f.across(x, z - 0.5);
  const g = Math.hypot(gx, gz) || 1;
  return [gx / g, gz / g];
}

// The ground under a plaza's paved circle (lowest and highest), or null where it would reach a
// sidewalk or the water, or stand on a hillside.
function plazaGround(heightAt, x, z) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k <= 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const rr = k === 12 ? 0 : 8;
    const p = heightAt.sample(x + Math.cos(a) * rr, z + Math.sin(a) * rr);
    if (p.dist < KERB + 0.2 || p.riverDist < p.riverHalf + 4 || p.h < 0.6 || p.mountain > 1 || p.townHill > 0.2 || p.park > 0.05) return null;
    lo = Math.min(lo, p.h);
    hi = Math.max(hi, p.h);
  }
  return hi - lo > 1.4 ? null : { lo, hi };
}

function plazaAt(heightAt, k0, k1) {
  const r = (q) => hash(k0 + 911, k1 - 377, q);
  if (r(1) < 0.4) return null;
  const [f0, f1] = heightAt.streetFamilies;
  const j = crossing(heightAt, k0 * f0.spacing, k1 * f1.spacing, k1 * f1.spacing, k0 * f0.spacing);
  if (!j) return null;
  const s = heightAt.sample(j.x, j.z);
  if (s.wild > 0.3) return null;
  // Into one of the four corners (the first that fits, from a random one), `off` from both streets.
  const off = KERB + PLAZA_CLEAR / 2 + 1;
  const kit = TOWN_KIT.find((k) => k.name === 'Kit_Fountain');
  const first = Math.floor(r(2) * 4);
  let x;
  let z;
  let nx;
  let nz;
  let quadrant;
  let ground = null;
  for (let q = 0; q < 4 && !ground; q++) {
    quadrant = (first + q) & 3;
    const s0 = quadrant & 1 ? -1 : 1;
    const s1 = quadrant & 2 ? -1 : 1;
    const c = offsetFromJunction(heightAt, k0, k1, j, s0 * off, s1 * off);
    if (!c) continue;
    ({ x, z } = c);
    const [gx, gz] = streetNormal(f0, x, z);
    nx = gx * s0;
    nz = gz * s0;
    ground = heightAt.sample(x, z).wild < 0.3 ? plazaGround(heightAt, x, z) : null;
  }
  if (!ground) return null;
  const b = kitBuilding(kit, x, z, kit.w, nx, nz, ground, r(4), 4 + r(5));
  b.clear = PLAZA_CLEAR;
  b.clearRadius = PLAZA_CLEAR * 0.71;
  b.quadrant = quadrant;
  return b;
}

// Corner buildings at a junction, in the corners its plaza (if any) leaves: a block that turns
// the corner (the turret block with its turret to the junction), so the rows run right up to it.
const CORNER_KITS = [['Kit_TurretCorner', 2], ['Kit_FlatBlock', 1], ['Kit_SlateBlock', 1], ['Kit_BrickWorks', 1]];
function cornersAt(heightAt, k0, k1, plaza) {
  const r = (q) => hash(k0 - 5003, k1 + 4001, q);
  const fams = heightAt.streetFamilies;
  const [f0, f1] = fams;
  const j = crossing(heightAt, k0 * f0.spacing, k1 * f1.spacing, k1 * f1.spacing, k0 * f0.spacing);
  if (!j || heightAt.sample(j.x, j.z).wild > 0.3) return [];
  const total = CORNER_KITS.reduce((n, [, w]) => n + w, 0);
  const out = [];
  for (let q = 0; q < 4; q++) {
    if (plaza?.quadrant === q || r(10 + q) < 0.15) continue;
    let left = r(20 + q) * total;
    const name = CORNER_KITS.find(([, w]) => (left -= w) < 0)?.[0] ?? CORNER_KITS[0][0];
    const kit = TOWN_KIT.find((k) => k.name === name);
    const side = [q & 1 ? -1 : 1, q & 2 ? -1 : 1];
    // Facing one street or the other: the one that puts the model's right side (+x, the
    // turret's side) toward the other street.
    // (Where the streets don't cross square, the corner nearest the junction needs more room.)
    for (const [a, extra] of [[0, 0.4], [1, 0.4], [0, 1.6], [1, 1.6], [0, 3], [1, 3]]) {
      const b = 1 - a;
      const offs = [];
      offs[a] = side[a] * (LINE + extra + kit.d / 2);
      offs[b] = side[b] * (LINE + extra + kit.w / 2);
      const c = offsetFromJunction(heightAt, k0, k1, j, offs[0], offs[1]);
      if (!c) continue;
      const [ax, az] = streetNormal(fams[a], c.x, c.z);
      const [bx, bz] = streetNormal(fams[b], c.x, c.z);
      const nx = ax * side[a];
      const nz = az * side[a];
      // u = (-nz, nx) must point toward street b, i.e. against b's side.
      if ((-nz * bx + nx * bz) * side[b] > 0) continue;
      const ground = footprintGround(heightAt, c.x, c.z, -nz, nx, nx, nz, kit.w, kit.d);
      if (!ground) continue;
      out.push(kitBuilding(kit, c.x, c.z, kit.w, nx, nz, ground, r(30 + q), 3 + r(40 + q)));
      break;
    }
  }
  return out;
}

// The landmarks and plazas within `radius` of a point.
function specialsNear(heightAt, x, z, radius) {
  let cache = specials.get(heightAt);
  if (!cache || cache.size > 20000) specials.set(heightAt, (cache = new Map()));
  const get = (key, make) => {
    if (!cache.has(key)) cache.set(key, make());
    return cache.get(key);
  };
  const out = [];
  const near = (b) => b && Math.abs(b.x - x) < radius + 30 && Math.abs(b.z - z) < radius + 30;
  for (let ci = Math.floor((x - radius - 60) / LANDMARK_CELL); ci <= Math.floor((x + radius + 60) / LANDMARK_CELL); ci++) {
    for (let cj = Math.floor((z - radius - 60) / LANDMARK_CELL); cj <= Math.floor((z + radius + 60) / LANDMARK_CELL); cj++) {
      const b = get(`L${ci},${cj}`, () => landmarkAt(heightAt, ci, cj));
      if (near(b)) out.push(b);
    }
  }
  const [f0, f1] = heightAt.streetFamilies;
  const a0 = f0.across(x, z);
  const a1 = f1.across(x, z);
  for (let k0 = Math.floor((a0 - radius - 60) / f0.spacing); k0 <= Math.ceil((a0 + radius + 60) / f0.spacing); k0++) {
    for (let k1 = Math.floor((a1 - radius - 60) / f1.spacing); k1 <= Math.ceil((a1 + radius + 60) / f1.spacing); k1++) {
      const b = get(`P${k0},${k1}`, () => plazaAt(heightAt, k0, k1));
      if (near(b)) out.push(b);
      for (const c of get(`C${k0},${k1}`, () => cornersAt(heightAt, k0, k1, b))) if (near(c)) out.push(c);
    }
  }
  return out;
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
  if (Math.hypot(a.x - b.x, a.z - b.z) > (a.clearRadius ?? a.radius) + (b.clearRadius ?? b.radius) + gap) return false;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  for (const [ax, az] of [[a.ux, a.uz], [a.nx, a.nz], [b.ux, b.uz], [b.nx, b.nz]]) {
    // (A fountain keeps its whole plaza clear, not just its basin.)
    const reach = (r) => (Math.abs(r.ux * ax + r.uz * az) * (r.clear ?? r.w) + Math.abs(r.nx * ax + r.nz * az) * (r.clear ?? r.d)) / 2;
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
    if (dx * dx + dz * dz > ((b.clearRadius ?? b.radius) + margin) ** 2) continue;
    if (Math.abs(dx * b.ux + dz * b.uz) < (b.clear ?? b.w) / 2 + margin && Math.abs(dx * b.nx + dz * b.nz) < (b.clear ?? b.d) / 2 + margin) return true;
  }
  return false;
}
