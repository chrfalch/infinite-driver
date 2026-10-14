// The sunny town's yard props (the kit in terrain/yard-kit.js) in front of its houses: flower pots,
// bins, benches and planters along the homes' fronts, café tables and chairs or a grocer's crates
// in front of the bigger blocks, and in the garden gaps between the houses of a row a picket fence
// or a hedge along the sidewalk with a doghouse, a bicycle, a wheelbarrow or a gnome behind it.
// Like terrain/props.js they come from the chunk's position alone (through its buildings), so the
// main thread and the physics worker agree.
//
// A prop: { kind (the kit model's name), x, y, z, yaw } with y its base on the ground and yaw
// turning the model's front (+z) to face (sin yaw, cos yaw).
import { generateBuildings, buildingsAround, insideBuilding } from './buildings.js';
import { CHUNK_RES, CHUNK_SIZE } from './chunk.js';
import { KERB, ROAD_HALF_WIDTH } from './town.js';
import { TOWN_KIT } from './town-kit.js';
import { YARD_KIT } from './yard-kit.js';

export const YARD_BY_NAME = new Map(YARD_KIT.map((k) => [k.name, k]));
const KIT_SIZE = new Map(TOWN_KIT.map((k) => [k.name, k.size]));
// Blocks that may have a café or a grocer on the ground floor; the rest are homes.
const SHOPS = new Set(['Kit_FlatBlock', 'Kit_SlateBlock', 'Kit_BrickWorks', 'Kit_TurretCorner', 'Kit_Townhouse']);

function hash(a, b, c) {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// The retaining wall along the back of the sidewalks (terrain/town.js): its foot and top, in m
// from the street's centre line. Props stand below or above it, never on it.
const WALL_FOOT = KERB + 0.3;
const WALL_TOP = KERB + 1.25;

// The street-row buildings (not the lots behind them, the second line or the landmarks).
const inRow = (b) => b.priority >= 1 && b.priority < 2 && KIT_SIZE.get(b.kit) !== 'landmark';

export function yardProps(heightAt, cx, cz) {
  if (!heightAt.buildingKit) return [];
  const around = buildingsAround(heightAt, cx, cz);
  const rows = around.map((r) => r.building).filter(inRow);
  const out = [];
  for (const rock of generateBuildings(heightAt, cx, cz)) {
    const b = rock.building;
    if (!inRow(b)) continue;
    const r = (q) => hash(Math.round(b.x * 10), Math.round(b.z * 10), q);
    // A spot by the building: s along its front (from its middle), a out from its front toward
    // the street: to the prop's back (against the wall), or to its middle if `mid` (negative: back
    // beside the building). The fronts stand on the blocks' retaining walls: a prop against one
    // stands on the sidewalk below it, its back to the wall's foot.
    const yawFront = Math.atan2(-b.nx, -b.nz);
    const put = (kind, s, a, yawOffset = 0, mid = false) => {
      const k = YARD_BY_NAME.get(kind);
      const half = Math.abs(Math.cos(yawOffset)) * k.d / 2 + Math.abs(Math.sin(yawOffset)) * k.w / 2;
      if (!mid) a += half;
      let x = b.x + b.ux * s - b.nx * (b.d / 2 + a);
      let z = b.z + b.uz * s - b.nz * (b.d / 2 + a);
      const yaw = yawFront + yawOffset;
      if (!mid) {
        const out = heightAt.sample(x, z).dist + half - WALL_FOOT;
        if (out > 0) {
          x -= b.nx * out;
          z -= b.nz * out;
        }
      }
      // Against a wall: stepped out from it until it stands level (on the sidewalk's flat).
      for (let step = 0; step < (mid ? 1 : 5); step++) {
        const y = fits(heightAt, around, out, k, x - b.nx * step * 0.2, z - b.nz * step * 0.2, yaw);
        if (y === null) continue;
        out.push({ kind, x: x - b.nx * step * 0.2, y, z: z - b.nz * step * 0.2, yaw });
        return true;
      }
      return false;
    };
    facade(b, put, r);
    garden(b, rows, put, r);
  }
  return out;
}

// Along the building's front: the door is taken to be in the middle, kept clear.
function facade(b, put, r) {
  const half = b.w / 2;
  if (r(1) < 0.15) return; // a bare front now and then
  const side = r(2) < 0.5 ? -1 : 1;
  if (SHOPS.has(b.kit) && r(3) < 0.55) {
    if (r(4) < 0.6) {
      // A café: tables with a chair either side out on the sidewalk, planters between.
      const tables = half > 4 ? 2 : 1;
      for (let i = 0; i < tables; i++) {
        const s = tables === 1 ? side * Math.min(2.2, half - 1) : (i ? 1 : -1) * Math.min(3.2, half - 1);
        if (!put('Yard_CafeTable', s, 1.25, 0, true)) continue;
        put('Yard_Chair', s - 0.68, 1.25, Math.PI / 2 + (r(10 + i) - 0.5) * 0.5, true);
        put('Yard_Chair', s + 0.68, 1.25, -Math.PI / 2 + (r(20 + i) - 0.5) * 0.5, true);
      }
      put('Yard_Planter', 0, 0.1);
    } else {
      // A grocer: fruit on a stand by the door, crates to the other side, a barrel.
      put('Yard_FruitCrates', side * 1.6, 0.1);
      put('Yard_CrateStack', -side * Math.min(half - 1.1, 3.0), 0.1, (r(5) - 0.5) * 0.3);
      put('Yard_Barrel', side * Math.min(half - 0.5, 3.0), 0.1);
    }
    return;
  }
  // A home: pots or topiaries either side of the door, then a bench or a planter, and the bins.
  if (r(8) < 0.7) {
    const kind = r(9) < 0.75 ? 'Yard_FlowerPot' : 'Yard_Topiary';
    put(kind, -1.0, 0.1);
    put(kind, 1.0, 0.1);
  }
  if (half > 2.6) {
    const t = r(11);
    if (t < 0.35) put('Yard_Bench', side * (half - 1.1), 0.1);
    else if (t < 0.65) put('Yard_Planter', side * (half - 0.9), 0.1);
  }
  if (r(12) < 0.45 && half > 2.2) {
    const s = -side * (half - 0.45);
    put('Yard_WheelieBin', s, 0.1);
    if (r(13) < 0.5) put('Yard_WheelieBin', s + side * 0.7, 0.1);
  }
  if (r(14) < 0.12) put('Yard_Gnome', (r(15) - 0.5) * 3, 0.5, (r(16) - 0.5));
}

// The garden between this building and the next one along its row (on its +u side): a fence or
// a hedge along the front, and a few things behind it.
function garden(b, rows, put, r) {
  let gap = Infinity;
  for (const o of rows) {
    if (o === b || o.nx * b.nx + o.nz * b.nz < 0.95) continue;
    const dx = o.x - b.x;
    const dz = o.z - b.z;
    const along = dx * b.ux + dz * b.uz;
    if (along <= 0 || Math.abs(dx * b.nx + dz * b.nz) > 4) continue;
    gap = Math.min(gap, along - b.w / 2 - o.w / 2);
  }
  if (gap < 2.2 || gap > 10) return;
  const s0 = b.w / 2;
  const mid = s0 + gap / 2;
  const n = Math.floor((gap - 0.2) / 2);
  const edge = r(30);
  // Along the top of the retaining wall; a mailbox takes the place of a stretch of fence (a gap
  // for the gate).
  if (edge < 0.55) {
    if (r(31) < 0.5) put('Yard_Mailbox', s0 + 0.4, -0.95, 0, true);
    for (let i = 0; i < n; i++) put('Yard_PicketFence', mid + (i - (n - 1) / 2) * 2, -0.8, 0, true);
  } else if (edge < 0.85) {
    for (let i = 0; i < n; i++) put('Yard_Hedge', mid + (i - (n - 1) / 2) * 2.05, -1.05, 0, true);
  }
  // Behind the front line (a < 0), beside the house.
  const depth = Math.min(b.d, 7);
  const things = ['Yard_Doghouse', 'Yard_Bicycle', 'Yard_Wheelbarrow', 'Yard_Gnome', 'Yard_GardenLamp', 'Yard_Topiary', 'Yard_Barrel'];
  const count = 1 + Math.floor(r(32) * 2.5);
  for (let i = 0; i < count; i++) {
    const kind = things[Math.floor(r(40 + i) * things.length)];
    const s = s0 + 0.3 + r(50 + i) * (gap - 0.6);
    const a = -1.9 - r(60 + i) * Math.max(0, depth - 2.6);
    put(kind, s, a, (r(70 + i) - 0.5) * (kind === 'Yard_Doghouse' ? 0.8 : 1.2), true);
  }
}

// The prop's footprint corners (x, z) turned by yaw.
function corners(k, x, z, yaw, grow = 0) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const hw = k.w / 2 + grow;
  const hd = k.d / 2 + grow;
  // Model x -> (cos, -sin), model z -> (sin, cos).
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [x + c * u * hw + s * v * hd, z - s * u * hw + c * v * hd]);
}

// The ground as the terrain's meshes and the physics' trimesh have it (terrain/chunk.js: heights on
// a grid of CHUNK_SIZE / CHUNK_RES, each square split along the same diagonal): smoother than
// heightAt where it bends sharply, like the foot and top of the retaining walls.
const STEP = CHUNK_SIZE / CHUNK_RES;
function meshHeight(heightAt, x, z) {
  const ground = heightAt.coarse ?? heightAt;
  const ix = Math.floor(x / STEP);
  const iz = Math.floor(z / STEP);
  const fx = x / STEP - ix;
  const fz = z / STEP - iz;
  const h01 = ground(ix * STEP, (iz + 1) * STEP);
  const h10 = ground((ix + 1) * STEP, iz * STEP);
  if (fx + fz < 1) {
    const h00 = ground(ix * STEP, iz * STEP);
    return h00 + fx * (h10 - h00) + fz * (h01 - h00);
  }
  const h11 = ground((ix + 1) * STEP, (iz + 1) * STEP);
  return h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11);
}

// Where a prop may stand: off the asphalt, the driveways and the parks, off the retaining walls,
// out of the buildings and clear of the props already placed, on level enough ground (a loose prop
// must stand flat on the physics' ground as well as the drawn one, or it would start inside a
// slope and be thrown out of it when woken). Its base's height (loose props on the highest point
// under them, fixed ones sunk to the lowest of the drawn ground's), or null.
function fits(heightAt, around, placed, k, x, z, yaw) {
  for (const [px, pz] of [...corners(k, x, z, yaw), [x, z]]) {
    const s = heightAt.sample(px, pz);
    if (s.dist < ROAD_HALF_WIDTH + 0.3 || (s.dist > WALL_FOOT + 0.01 && s.dist < WALL_TOP) || s.driveway > 0.05 || s.park > 0.05 || s.riverDist < s.riverHalf + 2 || s.h < 0.6) return null;
    if (insideBuilding(around, px, pz, 0.05)) return null;
  }
  const radius = Math.hypot(k.w, k.d) / 2;
  for (const p of placed) {
    const o = YARD_BY_NAME.get(p.kind);
    if (Math.hypot(p.x - x, p.z - z) < (radius + Math.hypot(o.w, o.d) / 2) * 0.72) return null;
  }
  // The ground under the footprint, on a 3 x 3 grid of points (the trimesh's corners can be inside it).
  let lo = Infinity;
  let hi = -Infinity;
  let meshLo = Infinity;
  let meshHi = -Infinity;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  for (const u of [-0.5, 0, 0.5]) {
    for (const v of [-0.5, 0, 0.5]) {
      const px = x + c * u * k.w + s * v * k.d;
      const pz = z - s * u * k.w + c * v * k.d;
      const h = heightAt(px, pz);
      const m = meshHeight(heightAt, px, pz);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
      meshLo = Math.min(meshLo, m);
      meshHi = Math.max(meshHi, m);
    }
  }
  if (k.body === 'fixed') return hi - lo > 0.6 ? null : lo;
  const top = Math.max(hi, meshHi);
  return top - Math.min(lo, meshLo) > 0.1 ? null : top;
}
