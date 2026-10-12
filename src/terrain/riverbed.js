// Dry river country: a winding, dry river bed floored with one continuous sheet of faceted sandstone
// that rises into walls of tall boulders along its banks, with open gum forest either side, on
// ground level with the bank tops. The bed only climbs (toward +x), in a staircase of level rock shelves and
// short steep risers, and it narrows to a tight gap between the walls and opens out again along its
// length. Like the canyon, everything comes from one deterministic height
// function, so physics colliders, the GPU tyre ground grid, tracks, soil and the render mesh agree.
//
// The beds are the zero lines of one warped periodic field (one family only, so they never cross);
// the origin is always on a bed. The distance to the nearest bed (|f| / |grad f|) shapes the
// cross-section.
//
// The rock sheet: three layers of boulders on jittered grids (small rocks, boulders, and big slabs
// up to 11 m long), each a faceted dome (a flat top cut by tilted side planes), merged by taking
// the highest at every point, with a chipped skin of creases a few cm deep over them. Patches of
// small rocks alternate with bigger boulders. So the bed is one surface of rock humps
// and creases, with no sand between them, and the same function gives the tyres, the colliders and
// the drawn rock mesh (render/rock-surface.js) their shape. Toward the banks the domes grow tall and
// steep into boulder walls the car cannot climb.
//
// Hard but drivable: shelves 5-10 m long, risers 2-3 m long climbing 0.6-2 m (about 15-35°, the
// car climbs 30° in low range); the humps stand 15-45 cm over the creases between them. The bed is
// 1.3-7.5 m either side of its centre line; its walls and banks move
// with it, so everything shaped by the distance from the bed uses bankDistance: the distance as
// if the bed were the usual BED_HALF_WIDTH.
import { createNoise2D } from 'simplex-noise';
import { mulberry32 } from './height.js';

export const BED_HALF_WIDTH = 4; // m, the flat bed either side of the centre line, at its usual width
// The rock sheet covers the bed and its walls out to ROCK_REACH (m of bankDistance), fading
// into the banks from ROCK_EDGE.
export const ROCK_EDGE = 8.2;
export const ROCK_REACH = 9.4;
const SPACING = 360; // m between neighbouring beds
const WIDTH_RANGE = [1.3, 7.5]; // m, the bed's half-width along its length
// The staircase: a riser every STEP_PERIOD m (give or take STEP_JITTER), climbing STEP_RISE m
// (give or take STEP_VARY) over 2-3 m, then a level shelf up to the next.
const STEP_PERIOD = 10;
const STEP_JITTER = 1.5;
const STEP_RISE = 1.3;
const STEP_VARY = 0.35;
const RISER_LENGTH = [2, 3];
const RISER_ANGLE = [22, 32]; // degrees: picks the riser's length for its rise (within RISER_LENGTH)
const ARC_STEP = 1; // m of x per slice when measuring the way along a bed
const RISER_ROUND = 0.12; // share of a riser's length its top and bottom edges are rounded over
const SIDES = 7; // side planes per boulder
// Soil pockets: firm earth fills the bed's creases and hollows up to a level that wanders between
// none and about 1.3 x SOIL_LEVEL over the ground beneath, so the rock humps stand out of flat patches of soil.
// Where it is deeper than SOIL_MIN the ground is soil, not bare rock: it takes tracks and ruts.
const SOIL_LEVEL = 0.18; // m
export const SOIL_MIN = 0.015; // m
const SOIL_STEP = 0.25; // m, grid the soil depth is cached on for rockAt (the sheet's own step)

// Maximum with a soft corner `k` wide, so there is no crease where the two cross.
const smoothMax = (a, b, k) => {
  const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (a - b)) / k));
  return b + (a - b) * h + k * h * (1 - h);
};

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function hash2(ix, iz, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// One faceted boulder's height at offset (dx, dz) from its centre: a flat-ish top cut by two rings
// of side planes, gentle ones near the top and steep ones lower down, round an ellipse of half
// axes a (along `turn`) and b. `key` seeds its facets.
function dome(dx, dz, tall, steep, a, b, turn, hx, hz, key, gentle = 0.35) {
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const u = dx * c + dz * s;
  const v = dz * c - dx * s;
  let drop = 0;
  for (let k = 0; k < SIDES; k++) {
    const ang = (k + 0.6 * (hash2(hx, hz, key + 20 + k) - 0.5)) * (6.2832 / SIDES);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    // The ellipse's radius in this direction, a little uneven.
    const r = ((a * b) / Math.hypot(b * ca, a * sa)) * (0.8 + 0.35 * hash2(hx, hz, key + 30 + k));
    const slope = steep * (0.75 + 0.5 * hash2(hx, hz, key + 40 + k));
    const cb = Math.cos(ang + 3.1416 / SIDES);
    const sb = Math.sin(ang + 3.1416 / SIDES);
    drop = Math.max(drop, slope * gentle * (u * ca + v * sa - 0.55 * r), slope * (u * cb + v * sb - 0.85 * r) + 0.2 * tall);
  }
  const tilt = 0.05 * ((hash2(hx, hz, key + 15) - 0.5) * dx + (hash2(hx, hz, key + 16) - 0.5) * dz);
  return tall + tilt - drop;
}

// One layer of boulders on a jittered grid of `cell` metres: `shape(hx, hz)` gives a boulder's
// { tall, steep, a, b, gentle? } (or null for none). Raises out.h to the highest boulder at (x, z).
function layer(x, z, cell, key, shape, out) {
  const cx = Math.floor(x / cell);
  const cz = Math.floor(z / cell);
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const hx = cx + i;
      const hz = cz + j;
      const b = shape(hx, hz);
      if (!b) continue;
      const dx = x - (hx + 0.15 + 0.7 * hash2(hx, hz, key)) * cell;
      const dz = z - (hz + 0.15 + 0.7 * hash2(hx, hz, key + 1)) * cell;
      // Quick reject: even its gentlest side cannot reach above the best so far.
      if (b.tall - b.steep * 0.26 * (Math.hypot(dx, dz) - Math.max(b.a, b.b) * 0.65) < out.h) continue;
      const h = dome(dx, dz, b.tall, b.steep, b.a, b.b, hash2(hx, hz, key + 14) * 3.1416, hx, hz, key, b.gentle);
      if (h > out.h) {
        out.h = h;
        // The id's whole part says which layer (0 small, 1 boulders, 2 slabs), for the colours.
        out.id = Math.floor(key / 100) - 1 + hash2(hx, hz, key + 17);
      }
    }
  }
}

export function createRiverField(seed = 4711) {
  const rand = mulberry32(seed);
  const warpA = createNoise2D(rand);
  const warpB = createNoise2D(rand);
  createNoise2D(rand); // (was the floor noise: kept so the noises after it stay the same)
  const hillNoise = createNoise2D(rand);
  const wanderNoise = createNoise2D(rand);
  const sizeNoise = createNoise2D(rand);
  const bankNoise = createNoise2D(rand);
  const ridgeNoise = createNoise2D(rand);
  const chipNoise = createNoise2D(rand);
  const soilNoise = createNoise2D(rand);
  const widthNoise = createNoise2D(rand);

  // Warped coordinate across the beds; a bed is where it is a multiple of the spacing. Long gentle
  // bends plus shorter wiggles.
  const wa0 = warpA(0, 0);
  const wb0 = warpB(0, 0);
  const across = (x, z) => z + 55 * (warpA(x * 0.0042, z * 0.0018) - wa0) + 6 * (warpB(x * 0.015, z * 0.015) - wb0);

  // Signed distance (m) to the nearest bed, and the unit gradient of the field (across the bed).
  function bed(x, z) {
    const e = 0.5;
    const a = across(x, z);
    const gx = (across(x + e, z) - across(x - e, z)) / (2 * e);
    const gz = (across(x, z + e) - across(x, z - e)) / (2 * e);
    const g = Math.hypot(gx, gz) || 1;
    const k = Math.round(a / SPACING);
    return { d: (a - k * SPACING) / g, gx: gx / g, gz: gz / g, k };
  }

  // The way along a bed: its length from x = 0 to the centre line's x (x always grows along a
  // bed: the field's slope across it never turns over). Summed over ARC_STEP m slices of x from 0
  // outward, in order, so every thread gets the same sums; cached per bed.
  const arcs = new Map();
  const centreZ = (x, k, z) => {
    for (let i = 0; i < 6; i++) z -= (across(x, z) - k * SPACING) / ((across(x, z + 0.25) - across(x, z - 0.25)) / 0.5);
    return z;
  };
  // Metres along the bed per metre of x at (x, z) on its centre line.
  const stretch = (x, z) => Math.hypot(1, (across(x + 0.25, z) - across(x - 0.25, z)) / (across(x, z + 0.25) - across(x, z - 0.25)));
  let lastK = NaN;
  let lastBed = null;
  function arcAt(i, k) {
    let b = k === lastK ? lastBed : arcs.get(k);
    if (!b) {
      const z = centreZ(0, k, k * SPACING);
      const r = stretch(0, z);
      b = { pos: { s: [0], z, r }, neg: { s: [0], z, r } };
      arcs.set(k, b);
    }
    lastK = k;
    lastBed = b;
    const side = i >= 0 ? b.pos : b.neg;
    const n = Math.abs(i);
    if (n < side.s.length) return side.s[n];
    const dir = i >= 0 ? 1 : -1;
    while (side.s.length <= n) {
      const x = dir * side.s.length * ARC_STEP;
      side.z = centreZ(x, k, side.z);
      const r = stretch(x, side.z);
      side.s.push(side.s[side.s.length - 1] + dir * 0.5 * (side.r + r) * ARC_STEP);
      side.r = r;
    }
    return side.s[n];
  }
  function along(cx, k) {
    const f = cx / ARC_STEP;
    const i = Math.floor(f);
    const a = arcAt(i, k);
    return a + (arcAt(i + 1, k) - a) * (f - i);
  }

  // The bed's half-width at `s` along it: stretches of a hundred metres or so that wander between
  // a tight gap and wide open rock.
  // Each bed (k) has its own.
  const widthAt = (s, k) =>
    Math.min(WIDTH_RANGE[1], Math.max(WIDTH_RANGE[0], BED_HALF_WIDTH + 4.4 * widthNoise(s * 0.0105, 0.5 + 9 * k) + 1.2 * widthNoise(s * 0.043, 7.5 + 9 * k)));

  // The staircase. Riser i starts at edge(i) and climbs from shelf i - 1 to shelf i; the shelves
  // stand at shelf(i), a steady climb plus a bounded wobble, so every riser goes up. Each bed (k)
  // has its own.
  const edge = (i, k) => i * STEP_PERIOD + STEP_JITTER * (2 * hash2(i, k, 501) - 1);
  const shelf = (i, k) => i * STEP_RISE + STEP_VARY * (2 * hash2(i, k, 502) - 1);
  const riser = (i, k) => {
    const rise = shelf(i, k) - shelf(i - 1, k);
    const angle = (RISER_ANGLE[0] + (RISER_ANGLE[1] - RISER_ANGLE[0]) * hash2(i, k, 503)) * (Math.PI / 180);
    return Math.min(RISER_LENGTH[1], Math.max(RISER_LENGTH[0], rise / Math.tan(angle)));
  };
  // A riser's climb over t = 0..1 of its length: a straight ramp with its edges rounded over.
  const c = RISER_ROUND;
  const ramp = (t) => {
    const m = 1 / (1 - c); // the ramp's slope between the rounded edges
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    if (t < c) return (m * t * t) / (2 * c);
    if (t > 1 - c) return 1 - (m * (1 - t) * (1 - t)) / (2 * c);
    return m * (t - c / 2);
  };
  // Bed floor height at `s` along the bed.
  function floorAlong(s, k) {
    let i = Math.floor(s / STEP_PERIOD) + 1;
    while (edge(i, k) > s) i--;
    const t = (s - edge(i, k)) / riser(i, k);
    return shelf(i - 1, k) + (shelf(i, k) - shelf(i - 1, k)) * ramp(t);
  }
  // The land far from the beds: their mean climb, blended between the two either side.
  function landAt(px, pz) {
    const f = across(px, pz) / SPACING;
    const k = Math.floor(f);
    const climb = (kk) => (along(px, kk) * STEP_RISE) / STEP_PERIOD;
    return climb(k) + (climb(k + 1) - climb(k)) * smoothstep(0, 1, f - k);
  }


  // Everything the renderer needs at a point; heightAt uses only .h.
  function sample(x, z) {
    const b = bed(x, z);
    // The bed is level side to side: its floor is taken at the centre line (so the risers run
    // straight across it), and so is the land either side, out to where the next bed takes over.
    const cxl = x - b.gx * b.d;
    const czl = z - b.gz * b.d;
    const s = along(cxl, b.k);
    // Distance from the bed as if it were BED_HALF_WIDTH wide: the walls and banks move with it.
    const dist = Math.abs(b.d) - (widthAt(s, b.k) - BED_HALF_WIDTH);
    const centre = floorAlong(s, b.k);
    // The land is level with the bank tops: the bed is a channel cut into it, and it steps up with
    // the bed's stairs. Past the bed's edge it goes by the floor a few metres further up (the floor
    // only climbs), so the banks beside a riser stand over the shelf at its top as well as the one
    // at its foot. Far out it eases onto the mean climb, blended with the next bed's.
    const ahead = floorAlong(s + 6 * smoothstep(BED_HALF_WIDTH + 0.5, BED_HALF_WIDTH + 4.5, dist), b.k);
    const far = smoothstep(120, 170, dist);
    const floor = far > 0 ? ahead + (landAt(x, z) - ahead) * far : ahead;
    const inBed = 1 - smoothstep(BED_HALF_WIDTH - 0.5, BED_HALF_WIDTH + 2.5, dist);

    let h = floor;
    // A shallow, meandering low channel down the bed (the last water ran there).
    const wander = 1.4 * wanderNoise(cxl * 0.02 + 11, czl * 0.02);
    const ch = b.d - wander;
    const channel = Math.exp(-(ch * ch) / 2.2);
    h -= 0.12 * channel;
    // Banks: rise 0.6-1.5 m off the bed edge, uneven along the bed.
    const bankRise = 0.6 + 0.9 * (0.5 + 0.5 * bankNoise(x * 0.018, z * 0.018));
    const bank = smoothstep(BED_HALF_WIDTH, BED_HALF_WIDTH + 4.5, dist);
    h += bank * bankRise;
    // Forest floor: level with the bank tops, with small bumps and a gentle swell.
    const forest = smoothstep(8, 40, dist);
    const hill = 0.5 + 0.5 * hillNoise(x * 0.011, z * 0.011);
    h += forest * 0.5 * hill + bank * 0.25 * bankNoise(x * 0.12, z * 0.12);
    // A low sandstone ridge far from the bed, between neighbours.
    const ridge = smoothstep(90, 150, dist);
    let rock = 0;
    if (ridge > 0) {
      const r = 0.5 + 0.5 * ridgeNoise(x * 0.005, z * 0.005);
      rock = ridge * r * 26;
      h += rock;
    }
    // The rock sheet over the bed and banks. Low humps in the bed, growing tall and steep into the
    // walls; the creases never drop to the ground beneath (a 4 cm skin at least), so it is all rock.
    const zone = 1 - smoothstep(ROCK_EDGE, ROCK_REACH, dist);
    let stone = 0;
    let soil = 0;
    const top = { h: -Infinity, id: 0 };
    const under = h;
    if (zone > 0) {
      const wall = smoothstep(BED_HALF_WIDTH + 0.6, BED_HALF_WIDTH + 2.4, dist);
      // Patches of small rocks and of bigger boulders, changing every 20-30 m (walls: big).
      const big = Math.max(wall, smoothstep(-0.35, 0.35, sizeNoise(x * 0.035, z * 0.035)));
      // Soil pockets: how high the soil lies here (a share of SOIL_LEVEL), in patches some metres
      // across, deeper in the low channel where the last water left its silt. Where it lies deep,
      // the small rocks are mostly buried, so the pockets run on for metres between boulders.
      const n = 0.5 + 0.5 * (0.75 * soilNoise(x * 0.045, z * 0.045) + 0.25 * soilNoise(x * 0.25 + 9, z * 0.25));
      const want = (1 - wall) * (1.45 * n - 0.15 + 0.45 * channel);
      const buried = smoothstep(0.55, 0.95, want);
      // Small rocks, about a metre across.
      layer(x, z, 1.1, 100, (hx, hz) => {
        const r = hash2(hx, hz, 102);
        return { tall: 0.26 * (0.75 + 0.5 * r) * (1 - 0.8 * big) * (1 - 0.75 * buried), steep: 1.1, a: 0.5 * (0.8 + 0.4 * r), b: 0.5 * (0.8 + 0.4 * r) };
      }, top);
      // Boulders, 2-3 m across, rising into the walls.
      layer(x, z, 2.2, 200, (hx, hz) => {
        const r = hash2(hx, hz, 202);
        const size = (0.9 + 0.3 * r) * (1 + 0.5 * wall);
        return { tall: 0.45 * (0.75 + 0.5 * r) * (0.3 + 0.7 * big) + 1.2 * wall, steep: 0.9 + 0.9 * wall, a: size, b: size * (0.8 + 0.3 * hash2(hx, hz, 203)) };
      }, top);
      // Big slabs, 8-11 m long and 3-4.5 m wide, in the bed only.
      if (wall < 1) {
        layer(x, z, 11, 300, (hx, hz) => {
          if (hash2(hx, hz, 301) > 0.75) return null;
          const r = hash2(hx, hz, 302);
          // Flat-topped (a gentle upper ring), 0.4-0.7 m tall: under the car's belly (0.62 m), so
          // it climbs on rather than beaching on the edge.
          return { tall: (0.4 + 0.3 * r) * (1 - wall), steep: 0.75, a: 4 + 1.5 * hash2(hx, hz, 303), b: 1.5 + 0.75 * r, gentle: 0.15 };
        }, top);
      }
      // A rough, chipped skin over every boulder: V-shaped creases (|noise|) at two scales, a few
      // cm deep, so the faces read as broken sandstone rather than smooth humps.
      const chip = 0.05 * (Math.abs(chipNoise(x * 0.9, z * 0.9)) - 0.35) + 0.025 * (Math.abs(chipNoise(x * 2.3 + 7, z * 2.3 - 4)) - 0.35);
      stone = zone * Math.max(0.04, top.h + chip);
      // Soil fills up to its level (not on the boulder walls); the rock pokes out above it, with a
      // soft corner where they meet.
      const level = zone * Math.max(0, SOIL_LEVEL * want);
      if (level > stone) {
        soil = level - stone;
        stone = smoothMax(stone, level, 0.02);
      }
      // The walls top out flush with the ground outside the river (no higher than the bank top
      // here would stand), so the bed is a gorge cut into level ground.
      const flush = smoothstep(BED_HALF_WIDTH - 1, BED_HALF_WIDTH + 0.6, dist);
      if (flush > 0) {
        const landTop = floorAlong(s + 6, b.k) + bankRise + forest * 0.5 * hill + 0.25 * bankNoise(x * 0.12, z * 0.12);
        const capped = Math.max(0.04 * zone, -smoothMax(-stone, under - landTop, 0.3));
        stone += (Math.min(stone, capped) - stone) * flush;
      }
      h += stone;
    }
    return { h, under, stone, soil, stoneId: top.id, rockZone: zone, road: inBed, rut: channel * inBed, dist, rock, bank, cliff: ridge, bedY: centre };
  }

  const heightAt = (x, z) => sample(x, z).h;
  // The ground beneath the rock sheet (a little below it where the sheet fades out), for the coarse
  // 1 m terrain mesh and its collider: the sheet's own mesh and collider lie on top.
  heightAt.coarse = (x, z) => {
    const s = sample(x, z);
    return s.stone > 0 ? s.under - 0.03 * s.rockZone : s.h;
  };
  // Soil depth at (x, z), between the points of a SOIL_STEP grid (cached: the tyres ask often).
  const soilCache = new Map();
  const soilCorner = (ix, iz) => {
    const key = ix * 1048576 + iz;
    let v = soilCache.get(key);
    if (v === undefined) {
      if (soilCache.size > 400000) soilCache.clear();
      v = sample(ix * SOIL_STEP, iz * SOIL_STEP).soil;
      soilCache.set(key, v);
    }
    return v;
  };
  heightAt.soilAt = (x, z) => {
    const gx = x / SOIL_STEP;
    const gz = z / SOIL_STEP;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const a = soilCorner(ix, iz) + (soilCorner(ix + 1, iz) - soilCorner(ix, iz)) * fx;
    const b = soilCorner(ix, iz + 1) + (soilCorner(ix + 1, iz + 1) - soilCorner(ix, iz + 1)) * fx;
    return a + (b - a) * fz;
  };
  // Bare rock (grippy, hard, no ruts) where the sheet is, except in its soil pockets.
  // The bed's half-width through a point, and the distance from it as if it were BED_HALF_WIDTH
  // wide (what the walls, banks, rocks and trees go by).
  heightAt.bedWidth = (x, z) => {
    const b = bed(x, z);
    return widthAt(along(x - b.gx * b.d, b.k), b.k);
  };
  heightAt.bankDistance = (x, z) => {
    const b = bed(x, z);
    return Math.abs(b.d) - (widthAt(along(x - b.gx * b.d, b.k), b.k) - BED_HALF_WIDTH);
  };
  heightAt.rockAt = (x, z) => heightAt.bankDistance(x, z) < (ROCK_EDGE + ROCK_REACH) / 2 && heightAt.soilAt(x, z) <= SOIL_MIN;
  heightAt.sample = sample;
  heightAt.roadDistance = (x, z) => Math.abs(bed(x, z).d);
  // Heading (radians about +y, 0 = +x) along the bed through a point.
  heightAt.roadHeading = (x, z) => {
    const r = bed(x, z);
    const dx = -r.gz;
    const dz = r.gx;
    return dx >= 0 ? Math.atan2(-dz, dx) : Math.atan2(dz, -dx);
  };
  heightAt.world = 'river';
  return heightAt;
}
