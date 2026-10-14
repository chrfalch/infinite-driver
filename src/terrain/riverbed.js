// Dry river country: a winding, dry river bed floored with one continuous sheet of faceted sandstone
// that rises into walls of tall boulders along its banks, with open gum forest either side, on
// ground level with the bank tops. The bed only climbs (toward +x), in a staircase of level rock shelves and
// short steep risers (bunched into cascades here, spread into long level runs there), and it narrows to a tight gap between the walls and opens out again along its
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
// The steps are worn like a real river's: their edges wander and lean across the bed, their risers
// are bare rock with blocks along the lip and at the foot (the gravel lies on the shelves, in drifts
// below the steps). The low channel the last water ran in meanders from side to side of the bed,
// cut into the rock as a steep-sided groove with potholes, and where it crosses a step the water has
// carved a spillway into it
// (a smooth slot worn back into the lip, gentler than the riser either side, with a plunge pool at
// its foot).
//
// Hard but drivable: shelves 1.5-20 m long, risers 2-3 m long climbing 0.6-2 m (about 20-35°, the
// car climbs 30° in low range; 12-20° up a spillway); the humps stand 15-45 cm over the creases between them. The bed is
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
// The staircase: a riser every STEP_PERIOD m (give or take STEP_JITTER) of a warped way along the
// bed, climbing STEP_RISE m (give or take STEP_VARY) over 2-3 m, then a level shelf up to the next.
// The warp (STEP_WARP m, over a few hundred metres) bunches the risers into cascades of short
// shelves and spreads them into long level runs, so the stairs have no steady beat.
const STEP_PERIOD = 10;
const STEP_WARP = 42;
const STEP_JITTER = 1.5;
const STEP_RISE = 1.3;
const STEP_VARY = 0.35;
const RISER_LENGTH = [2, 3];
const RISER_ANGLE = [21, 30]; // degrees: picks the riser's length for its rise (within RISER_LENGTH)
const ARC_STEP = 1; // m of x per slice when measuring the way along a bed
// Shares of a riser's length its top and bottom edges are rounded over: a sharp lip, a softer foot.
const LIP_ROUND = 0.06;
const FOOT_ROUND = 0.18;
// The step edges are not straight across the bed: each wanders up and down the bed by about
// EDGE_WANDER m and leans across it. Where the low channel crosses it the water has carved a
// spillway: a slot worn back into the lip, its riser up to SPILL_STRETCH times longer (so gentler:
// the line to drive), and a plunge pool scoured at its foot.
const EDGE_WANDER = 1.3;
const EDGE_LEAN = 0.3;
const SPILL_STRETCH = 1.9;
// The low channel: the groove the water wore into the rock, meandering from side to side of the bed
// (bends every 20-30 m, as far out as the bed allows) and cut in with steep sides, CHANNEL_HALF m
// either side of its line and CHANNEL_DEPTH m deep (deeper where the bed narrows and the water ran
// fast), with potholes ground into its floor here and there.
const CHANNEL_HALF = 1.1;
const CHANNEL_DEPTH = [0.15, 0.5];
const POOL_DEPTH = 0.28; // m per m of the next step's rise (at most 0.4 m)
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
  const edgeNoise = createNoise2D(rand);

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

  // The staircase, on a warped way along the bed (w), which runs 0.5-1.5 m per metre of s: where
  // it runs fast the risers bunch into a cascade, where it runs slow the shelves stretch out. Three
  // waves of a few hundred metres, their phases per bed (k); `rate` is dw/ds.
  const WAVES = [
    [0.5, 0.0061],
    [0.3, 0.017],
    [0.2, 0.041],
  ];
  let phaseK = NaN;
  const phases = [0, 0, 0];
  // Sets warped.w and warped.rate at `s`.
  const warped = { w: 0, rate: 1 };
  const warpAt = (s, k) => {
    if (k !== phaseK) {
      for (let j = 0; j < 3; j++) phases[j] = 6.2832 * hash2(k, j, 504);
      phaseK = k;
    }
    let w = s;
    let r = 1;
    for (let j = 0; j < 3; j++) {
      const a = WAVES[j][1] * s + phases[j];
      w += STEP_WARP * WAVES[j][0] * Math.sin(a);
      r += STEP_WARP * WAVES[j][0] * WAVES[j][1] * Math.cos(a);
    }
    warped.w = w;
    warped.rate = r;
    return warped;
  };
  const warp = (s, k) => {
    if (k !== phaseK) warpAt(0, k);
    let w = s;
    for (let j = 0; j < 3; j++) w += STEP_WARP * WAVES[j][0] * Math.sin(WAVES[j][1] * s + phases[j]);
    return w;
  };
  // The low channel's line across the bed (m from the centre line) at `s` along it: a share of the
  // room the bed leaves it, swinging from side to side.
  const channelLine = (s, k) => {
    // (Out to the foot of the walls, and with small kinks where it found its way between rocks.)
    const swing = Math.max(-1, Math.min(1, 1.25 * wanderNoise(s * 0.034, 11 + 7 * k) + 0.3 * wanderNoise(s * 0.11, 40 + 7 * k)));
    return swing * Math.max(0.4, widthAt(s, k) - 0.5 * CHANNEL_HALF) + 0.3 * wanderNoise(s * 0.3, 90 + 7 * k);
  };
  // Where riser i's spillway is across the bed: where the channel crosses it, a couple of metres
  // up it (cached). One place per riser, so a riser's length at a point does not change along it.
  const lines = new Map();
  const spillway = (d, i, k) => {
    if (d === Infinity) return 0;
    const key = k * 1048576 + i;
    let c = lines.get(key);
    if (c === undefined) {
      if (lines.size > 100000) lines.clear();
      c = channelLine(start(i, k) + 2, k);
      lines.set(key, c);
    }
    // A little wider than the channel (the car fits in it).
    return Math.exp(-((d - c) ** 2) / 3.2);
  };
  // Riser i starts at edge(i) (in w) and climbs from shelf i - 1 to shelf i; the shelves stand at
  // shelf(i), a steady climb plus a bounded wobble, so every riser goes up. Each bed (k) has its own.
  const edge = (i, k) => i * STEP_PERIOD + STEP_JITTER * (2 * hash2(i, k, 501) - 1);
  // Where along the bed (s) riser i starts: where the warped way reaches its edge (cached).
  const starts = new Map();
  const start = (i, k) => {
    const key = k * 1048576 + i;
    let s = starts.get(key);
    if (s === undefined) {
      if (starts.size > 100000) starts.clear();
      const e = edge(i, k);
      s = e;
      for (let n = 0; n < 6; n++) {
        const at = warpAt(s, k);
        s -= (at.w - e) / at.rate;
      }
      starts.set(key, s);
    }
    return s;
  };
  const shelf = (i, k) => i * STEP_RISE + STEP_VARY * (2 * hash2(i, k, 502) - 1);
  const riser = (i, k) => {
    const rise = shelf(i, k) - shelf(i - 1, k);
    const angle = (RISER_ANGLE[0] + (RISER_ANGLE[1] - RISER_ANGLE[0]) * hash2(i, k, 503)) * (Math.PI / 180);
    return Math.min(RISER_LENGTH[1], Math.max(RISER_LENGTH[0], rise / Math.tan(angle)));
  };
  // A riser's climb over t = 0..1 of its length: a straight ramp with its foot rounded over a
  // little more than its lip.
  const ramp = (t) => {
    const a = FOOT_ROUND;
    const c = LIP_ROUND;
    const m = 1 / (1 - (a + c) / 2); // the ramp's slope between the rounded edges
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    if (t < a) return (m * t * t) / (2 * a);
    if (t > 1 - c) return 1 - (m * (1 - t) * (1 - t)) / (2 * c);
    return m * (t - a / 2);
  };
  // Where `s` along the bed is on the staircase: the floor height, and (in m along the bed) how far
  // it is past the start of the riser it is on or above (`past`), that riser's length and rise,
  // and how far it is to the start of the next riser up (`next`) and its rise; at `d` m across the
  // bed, how far into the riser's spillway (`spill`) and the next one's (`nextSpill`). A spillway
  // lengthens the riser up the bed, short of the next one.
  const step = { y: 0, past: 0, len: 1, rise: 0, next: 0, nextRise: 0, spill: 0, nextSpill: 0 };
  function stairAt(s, k, d = Infinity) {
    const w = warp(s, k);
    let i = Math.floor(w / STEP_PERIOD) + 1;
    while (edge(i, k) > w) i--;
    const from = start(i, k);
    const to = start(i + 1, k);
    let len = riser(i, k);
    const spill = spillway(d, i, k);
    if (spill > 0.001) len = Math.min(len * (1 + (SPILL_STRETCH - 1) * spill), Math.max(len, to - from - 1.5));
    const past = s - from;
    const lo = shelf(i - 1, k);
    const hi = shelf(i, k);
    step.y = lo + (hi - lo) * ramp(past / len);
    step.past = past;
    step.len = len;
    step.rise = hi - lo;
    step.next = to - s;
    step.nextRise = shelf(i + 1, k) - hi;
    step.spill = spill;
    step.nextSpill = d === Infinity ? 0 : spillway(d, i + 1, k);
    return step;
  }
  // Bed floor height at `s` along the bed.
  const floorAlong = (s, k, d) => stairAt(s, k, d).y;
  // How far the step edges are pushed up the bed (m of s) at `d` m across it.
  const edgeShift = (d, s, k) =>
    EDGE_WANDER * (edgeNoise(d * 0.22, s * 0.012 + 7 * k) + 0.3 * edgeNoise(d * 0.75 + 20, s * 0.025 + 7 * k)) + (d && EDGE_LEAN * edgeNoise(s * 0.013, 40.5 + 7 * k) * d);
  // The land far from the beds: their mean climb, blended between the two either side.
  function landAt(px, pz) {
    const f = across(px, pz) / SPACING;
    const k = Math.floor(f);
    const climb = (kk) => (warp(along(px, kk), kk) * STEP_RISE) / STEP_PERIOD;
    return climb(k) + (climb(k + 1) - climb(k)) * smoothstep(0, 1, f - k);
  }


  // Everything the renderer needs at a point; heightAt uses only .h.
  function sample(x, z) {
    const b = bed(x, z);
    // The bed's floor goes by the way along it at the centre line (shifted by the step edges'
    // wander, below), and so does the land either side, out to where the next bed takes over.
    const cxl = x - b.gx * b.d;
    const czl = z - b.gz * b.d;
    const s = along(cxl, b.k);
    // Distance from the bed as if it were BED_HALF_WIDTH wide: the walls and banks move with it.
    const width = widthAt(s, b.k);
    const dist = Math.abs(b.d) - (width - BED_HALF_WIDTH);
    // The low channel: where across the bed it runs (a share of the room the bed leaves it), and
    // how close to it this point is (`channel`, a soft 0-1) and how far down its groove (`groove`).
    const wander = channelLine(s, b.k);
    const ch = b.d - wander;
    const channel = Math.exp(-(ch * ch) / 2.2);
    // (Its width varies along it: 0.75-1.45 x CHANNEL_HALF.)
    const half = CHANNEL_HALF * (1.1 + 0.35 * wanderNoise(s * 0.06, 130 + 7 * b.k));
    const groove = 1 - smoothstep(0.45 * half, half, Math.abs(ch));
    // The way along the bed the staircase goes by here: shifted by the step edges' wander (the same
    // either side of the bed's edge, out into the banks).
    const reach = width + 1;
    const dc = Math.max(-reach, Math.min(reach, b.d));
    const sb = s - edgeShift(dc, s, b.k);
    const centre = floorAlong(s - edgeShift(0, s, b.k), b.k, 0);
    // The land is level with the bank tops: the bed is a channel cut into it, and it steps up with
    // the bed's stairs. Past the bed's edge it goes by the floor a few metres further up (the floor
    // only climbs), so the banks beside a riser stand over the shelf at its top as well as the one
    // at its foot. Far out it eases onto the mean climb, blended with the next bed's.
    // Around a step in the bed: `ledge` over the riser and just past its lip (bare rock, blocks),
    // `foot` at its foot (blocks fallen off the lip, a shallow scour), and `bar` the gravel the
    // last water dropped on the shelf below it, a couple of metres on.
    const inBed = 1 - smoothstep(BED_HALF_WIDTH - 0.5, BED_HALF_WIDTH + 2.5, dist);
    const st = stairAt(sb, b.k, dc);
    const spill = st.spill * inBed;
    const tall = smoothstep(0.4, 0.9, st.rise); // (only steps of some size drop blocks)
    // (Ragged: the bare rock runs on past some stretches of the lip, and the gravel lies in drifts.)
    const ragged = edgeNoise(x * 0.4 + 31, z * 0.4);
    const ledge = inBed * (1 - smoothstep(st.len + 0.2, st.len + 1.2, st.past - 1.2 * ragged));
    // (Both fade out at the riser's start, so the ground stays continuous there.)
    const foot = inBed * tall * smoothstep(0, 0.5, st.next) * Math.exp(-((st.next - 0.6) ** 2) / 0.8);
    const bar = inBed * smoothstep(0.8, 2, st.next) * (1 - smoothstep(3.5, 6, st.next)) * smoothstep(-0.2, 0.5, -ragged);
    // The plunge pool below the next spillway up, and `scour`: where the water wore the rock smooth
    // (the spillway's slot and its pool), with no loose rocks or blocks.
    const pool = inBed * st.nextSpill * smoothstep(0.4, 0.9, st.nextRise) * smoothstep(0, 1.2, st.next) * Math.exp(-((st.next - 2.4) ** 2) / 2.9);
    const poolDepth = Math.min(0.4, POOL_DEPTH * st.nextRise) * pool;
    const scour = Math.max(pool, spill * (1 - smoothstep(st.len, st.len + 1.5, st.past)), inBed * groove);
    const stepRise = st.rise;
    const lookAhead = 6 * smoothstep(BED_HALF_WIDTH + 0.5, BED_HALF_WIDTH + 4.5, dist);
    const ahead = lookAhead > 0 ? floorAlong(sb + lookAhead, b.k) : st.y;
    const far = smoothstep(120, 170, dist);
    const floor = far > 0 ? ahead + (landAt(x, z) - ahead) * far : ahead;

    let h = floor;
    // The groove: deeper where the bed is narrow, varying along it, and potholes in its floor (one
    // in three 4 m cells of the bed holds one, 0.8-1.4 m across).
    const narrow = 1 - smoothstep(2, 5.5, width);
    const depth = CHANNEL_DEPTH[0] + (CHANNEL_DEPTH[1] - CHANNEL_DEPTH[0]) * Math.min(1, 0.6 * narrow + 0.5 * (0.5 + 0.5 * wanderNoise(s * 0.05, 70 + 7 * b.k)));
    let pothole = 0;
    if (groove > 0) {
      const cx = Math.floor(x / 4);
      const cz = Math.floor(z / 4);
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const hx = cx + i;
          const hz = cz + j;
          if (hash2(hx, hz, 601) > 0.33) continue;
          const r = 0.4 + 0.3 * hash2(hx, hz, 602);
          const dx = x - (hx + 0.2 + 0.6 * hash2(hx, hz, 603)) * 4;
          const dz = z - (hz + 0.2 + 0.6 * hash2(hx, hz, 604)) * 4;
          pothole = Math.max(pothole, 1 - smoothstep(0.3 * r, r, Math.hypot(dx, dz)));
        }
      }
      pothole *= groove * groove;
    }
    h -= inBed * (depth * groove + 0.04 * channel + 0.3 * pothole);
    h -= 0.08 * foot * stepRise + poolDepth;
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
      // At a step: boulders only.
      const big = Math.max(wall, ledge * (1 - scour), foot * (1 - scour), smoothstep(-0.35, 0.35, sizeNoise(x * 0.035, z * 0.035)));
      // Soil pockets: how high the soil lies here (a share of SOIL_LEVEL), in patches some metres
      // across, deeper in the low channel where the last water left its silt. Where it lies deep,
      // the small rocks are mostly buried, so the pockets run on for metres between boulders.
      const n = 0.5 + 0.5 * (0.75 * soilNoise(x * 0.045, z * 0.045) + 0.25 * soilNoise(x * 0.25 + 9, z * 0.25));
      // None on a riser (the water swept it bare), more on the bar below it.
      const want = (1 - wall) * (1 - ledge) * Math.min(1.4, 1.45 * n - 0.15 + 0.3 * channel + 0.35 * bar);
      const buried = smoothstep(0.55, 0.95, want);
      // Small rocks, about a metre across.
      layer(x, z, 1.1, 100, (hx, hz) => {
        const r = hash2(hx, hz, 102);
        return { tall: 0.26 * (0.75 + 0.5 * r) * (1 - 0.8 * big) * (1 - 0.75 * buried) * (1 - 0.8 * scour), steep: 1.1, a: 0.5 * (0.8 + 0.4 * r), b: 0.5 * (0.8 + 0.4 * r) };
      }, top);
      // Boulders, 2-3 m across, rising into the walls.
      layer(x, z, 2.2, 200, (hx, hz) => {
        const r = hash2(hx, hz, 202);
        const size = (0.9 + 0.3 * r) * (1 + 0.5 * wall);
        // Blockier and taller along a step's lip and at its foot (the lip breaks up into them).
        // Worn down to low smooth humps in a spillway and its pool.
        const blocks = Math.max(ledge, foot) * (1 - wall) * (1 - scour);
        return { tall: 0.45 * (0.75 + 0.5 * r) * (0.3 + 0.7 * big) * (1 + 0.3 * blocks) * (1 - 0.7 * scour) + 1.2 * wall, steep: 0.9 + 0.9 * wall + 0.5 * blocks, a: size, b: size * (0.8 + 0.3 * hash2(hx, hz, 203)) };
      }, top);
      // Big slabs, 8-11 m long and 3-4.5 m wide, in the bed only.
      if (wall < 1) {
        layer(x, z, 11, 300, (hx, hz) => {
          if (hash2(hx, hz, 301) > 0.75) return null;
          const r = hash2(hx, hz, 302);
          // Flat-topped (a gentle upper ring), 0.4-0.7 m tall: under the car's belly (0.62 m), so
          // it climbs on rather than beaching on the edge.
          return { tall: (0.4 + 0.3 * r) * (1 - wall) * (1 - 0.8 * scour), steep: 0.75, a: 4 + 1.5 * hash2(hx, hz, 303), b: 1.5 + 0.75 * r, gentle: 0.15 };
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
        const landTop = floorAlong(sb + 6, b.k) + bankRise + forest * 0.5 * hill + 0.25 * bankNoise(x * 0.12, z * 0.12);
        const capped = Math.max(0.04 * zone, -smoothMax(-stone, under - landTop, 0.3));
        stone += (Math.min(stone, capped) - stone) * flush;
      }
      h += stone;
    }
    return { h, under, stone, soil, stoneId: top.id, rockZone: zone, road: inBed, rut: channel * inBed, spill: scour, stepY: floor, dist, rock, bank, cliff: ridge, bedY: centre };
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
  // The beds' centre lines, for what is set out along them (terrain/track-markers.js): bed k's
  // centre line crosses x at z = centre(x, k) (`guess` near it, e.g. the last one, converges
  // faster), `along(x, k)` m along it from x = 0, and `width(s, k)` its half-width there.
  heightAt.beds = {
    spacing: SPACING,
    across,
    centre: (x, k, guess = k * SPACING) => {
      let z = guess;
      for (let i = 0; i < 4; i++) z = centreZ(x, k, z);
      return z;
    },
    along,
    width: widthAt,
    floor: (s, k) => floorAlong(s, k, 0),
  };
  heightAt.world = 'river';
  return heightAt;
}
