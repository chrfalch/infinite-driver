// Dry river country: a winding, dry river bed of yellow sand and sandstone slabs, with low banks
// of cobbles and open gum forest either side, rolling hills beyond. The bed climbs and dips
// gently along its length. Like the canyon, everything comes from one deterministic height
// function, so physics colliders, the GPU tyre ground grid, tracks, soil and the render mesh agree.
//
// The beds are the zero lines of one warped periodic field (one family only, so they never cross);
// the origin is always on a bed. The distance to the nearest bed (|f| / |grad f|) shapes the
// cross-section.
//
// Kept easy to drive: the bed floor stays under about 8° along the bed, bedrock ledges are at most
// ~20 cm and ramp up over about a metre, slabs stand 5-20 cm proud with rounded edges.
import { createNoise2D } from 'simplex-noise';
import { mulberry32 } from './height.js';
import { SLAB_INSET, SLAB_SAND_SHARE, SLAB_SEED, slabCells, slabHash } from './slabs.js';

export const BED_HALF_WIDTH = 4; // m, the flat sandy bed either side of the centre line
const SPACING = 360; // m between neighbouring beds
const LEDGE_STEP = 0.18; // m, height of a bedrock ledge across the bed

// Maximum with a soft corner `k` wide, so there is no crease where the two cross.
const smoothMax = (a, b, k) => {
  const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (a - b)) / k));
  return b + (a - b) * h + k * h * (1 - h);
};

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function createRiverField(seed = 4711) {
  const rand = mulberry32(seed);
  const warpA = createNoise2D(rand);
  const warpB = createNoise2D(rand);
  const floorNoise = createNoise2D(rand);
  const hillNoise = createNoise2D(rand);
  const ledgeNoise = createNoise2D(rand);
  const slabNoise = createNoise2D(rand);
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

  // Sandstone slabs (terrain/slabs.js): a plate stands a little proud of the sand, slightly tilted,
  // with rounded edges (it rises over 0.8 m from its edge), and sand between plates.
  function slabAt(x, z) {
    const c = slabCells(x, z);
    if (slabHash(c.hx, c.hz, SLAB_SEED + 2) < SLAB_SAND_SHARE) return 0;
    const edge = (c.d2 - c.d1) / 2 - SLAB_INSET; // m inside the plate's edge
    if (edge <= 0) return 0;
    const tall = 0.04 + 0.12 * slabHash(c.hx, c.hz, SLAB_SEED + 3);
    const tiltX = (slabHash(c.hx, c.hz, SLAB_SEED + 4) - 0.5) * 0.05;
    const tiltZ = (slabHash(c.hx, c.hz, SLAB_SEED + 5) - 0.5) * 0.05;
    const top = tall + tiltX * (x - c.px) + tiltZ * (z - c.pz) + 0.02 * slabNoise(x * 0.8, z * 0.8);
    return Math.max(0, top) * smoothstep(0, 0.8, edge);
  }

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
    // Slabs: bedrock showing along the bank foot (the bed itself is loose rock, see rocks.js).
    const slabs = smoothstep(BED_HALF_WIDTH - 0.5, BED_HALF_WIDTH + 1.5, dist) * (1 - smoothstep(8, 11, dist));
    const slab = slabs > 0 ? slabAt(x, z) * slabs : 0;
    h += slab;
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
    return { h, road: inBed, rut: channel * inBed, dist, rock: rock + slab * 5, slab, slabZone: slabs, bank, cliff: ridge };
  }

  const heightAt = (x, z) => sample(x, z).h;
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
