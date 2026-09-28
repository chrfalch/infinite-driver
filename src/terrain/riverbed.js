// Dry river country: a winding, dry river bed floored with one continuous sheet of faceted sandstone
// that rises into walls of tall boulders along its banks, with open gum forest either side and
// rolling hills beyond. The bed climbs and dips gently along its length. Like the canyon, everything comes from one deterministic height
// function, so physics colliders, the GPU tyre ground grid, tracks, soil and the render mesh agree.
//
// The beds are the zero lines of one warped periodic field (one family only, so they never cross);
// the origin is always on a bed. The distance to the nearest bed (|f| / |grad f|) shapes the
// cross-section.
//
// The rock sheet: three layers of boulders on jittered grids (small rocks, boulders, and big slabs
// up to 11 m long), each a faceted dome (a flat top cut by tilted side planes), merged by taking
// the highest at every point. Patches of small rocks alternate with bigger boulders. So the bed is one surface of rock humps
// and creases, with no sand between them, and the same function gives the tyres, the colliders and
// the drawn rock mesh (render/rock-surface.js) their shape. Toward the banks the domes grow tall and
// steep into boulder walls the car cannot climb.
//
// Kept drivable: the bed floor stays under about 8° along the bed, the humps stand 15-45 cm over
// the creases between them, and bedrock ledges are at most ~20 cm.
import { createNoise2D } from 'simplex-noise';
import { mulberry32 } from './height.js';

export const BED_HALF_WIDTH = 4; // m, the flat bed either side of the centre line
// The rock sheet covers the bed and its walls out to ROCK_REACH (m from the centre line), fading
// into the banks from ROCK_EDGE.
export const ROCK_EDGE = 8.2;
export const ROCK_REACH = 9.4;
const SPACING = 360; // m between neighbouring beds
const LEDGE_STEP = 0.18; // m, height of a bedrock ledge across the bed
const SIDES = 7; // side planes per boulder

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
  const floorNoise = createNoise2D(rand);
  const hillNoise = createNoise2D(rand);
  const ledgeNoise = createNoise2D(rand);
  const sizeNoise = createNoise2D(rand);
  const bankNoise = createNoise2D(rand);
  const ridgeNoise = createNoise2D(rand);

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

  // Bed floor height along the bed: rolling climbs and dips (up to about 6°, 8° briefly).
  const floorAt = (px, pz) => 9 * floorNoise(px * 0.003, pz * 0.003) + 1.2 * floorNoise(px * 0.011 + 5, pz * 0.011 + 3);

  // Everything the renderer needs at a point; heightAt uses only .h.
  function sample(x, z) {
    const b = bed(x, z);
    const dist = Math.abs(b.d);
    // The bed is level side to side: its floor is taken at the centre line, then blends into the
    // local height further out.
    const cxl = x - b.gx * b.d;
    const czl = z - b.gz * b.d;
    const centre = floorAt(cxl, czl);
    const level = 1 - smoothstep(BED_HALF_WIDTH + 2, 26, dist);
    // A river bed is the low line of its valley: the land either side never drops below it.
    const floor = centre * level + smoothMax(floorAt(x, z), centre, 3) * (1 - level);

    // Bedrock ledges across the bed: the floor is terraced into shelves joined by short ramps. On
    // the level stretches there are none; where the bed climbs or dips there is one every few
    // metres of height. The ledge line wiggles across the bed.
    const inBed = 1 - smoothstep(BED_HALF_WIDTH - 0.5, BED_HALF_WIDTH + 2.5, dist);
    let ledge = 0;
    if (inBed > 0) {
      // Where the bed is already steep the ramps would get too steep, so the ledges fade out there.
      const grade = Math.abs(floorAt(cxl - b.gz, czl + b.gx) - floorAt(cxl + b.gz, czl - b.gx)) / 2;
      const strength = inBed * (1 - smoothstep(0.07, 0.12, grade));
      if (strength > 0) {
        const v = centre + 0.08 * ledgeNoise(x * 0.35, z * 0.35);
        const f = v / LEDGE_STEP;
        const k = Math.floor(f);
        // Flat for 60 % of each step, then a ramp up to the next shelf.
        ledge = ((k + smoothstep(0.6, 1, f - k)) * LEDGE_STEP - v) * strength;
      }
    }

    let h = floor + ledge;
    // A shallow, meandering low channel down the bed (the last water ran there).
    const wander = 1.4 * ledgeNoise(cxl * 0.02 + 11, czl * 0.02);
    const ch = b.d - wander;
    const channel = Math.exp(-(ch * ch) / 2.2);
    h -= 0.12 * channel;
    // Banks: rise 0.6-1.5 m off the bed edge, uneven along the bed.
    const bankRise = 0.6 + 0.9 * (0.5 + 0.5 * bankNoise(x * 0.018, z * 0.018));
    const bank = smoothstep(BED_HALF_WIDTH, BED_HALF_WIDTH + 4.5, dist);
    h += bank * bankRise;
    // Forest floor: rolling ground, with small bumps.
    const forest = smoothstep(8, 40, dist);
    const hill = 0.5 + 0.5 * hillNoise(x * 0.011, z * 0.011);
    h += forest * (2 + 7 * hill) + bank * 0.25 * bankNoise(x * 0.12, z * 0.12);
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
    const top = { h: -Infinity, id: 0 };
    const under = h;
    if (zone > 0) {
      const wall = smoothstep(BED_HALF_WIDTH + 0.6, BED_HALF_WIDTH + 2.4, dist);
      // Patches of small rocks and of bigger boulders, changing every 20-30 m (walls: big).
      const big = Math.max(wall, smoothstep(-0.35, 0.35, sizeNoise(x * 0.035, z * 0.035)));
      // Small rocks, about a metre across.
      layer(x, z, 1.1, 100, (hx, hz) => {
        const r = hash2(hx, hz, 102);
        return { tall: 0.26 * (0.75 + 0.5 * r) * (1 - 0.8 * big), steep: 1.1, a: 0.5 * (0.8 + 0.4 * r), b: 0.5 * (0.8 + 0.4 * r) };
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
      stone = zone * Math.max(0.04, top.h);
      h += stone;
    }
    return { h, under, stone, stoneId: top.id, rockZone: zone, road: inBed, rut: channel * inBed, dist, rock, bank, cliff: ridge };
  }

  const heightAt = (x, z) => sample(x, z).h;
  // The ground beneath the rock sheet (a little below it where the sheet fades out), for the coarse
  // 1 m terrain mesh and its collider: the sheet's own mesh and collider lie on top.
  heightAt.coarse = (x, z) => {
    const s = sample(x, z);
    return s.stone > 0 ? s.under - 0.03 * s.rockZone : s.h;
  };
  // Bare rock (grippy, hard, no ruts) where the sheet is.
  heightAt.rockAt = (x, z) => Math.abs(bed(x, z).d) < (ROCK_EDGE + ROCK_REACH) / 2;
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
