// Dark town: a diorama-like world of winding asphalt streets with sidewalks, rows of houses
// and towers along them (terrain/buildings.js), parks and ponds in the blocks, a river through the
// lowlands, and wild districts where forested hills rise into grey granite mountains. Everything
// comes from one deterministic height function, so physics, tyres, tracks and the render mesh agree.
//
// The streets are the zero lines of two warped periodic fields, as in the canyon (terrain/canyon.js),
// closer together and more winding. A third, wider family is the river. The origin is on a street.
import { createNoise2D } from 'simplex-noise';
import { mulberry32 } from './height.js';

export const ROAD_HALF_WIDTH = 3.4; // m of asphalt either side of the centre line
export const KERB = 5.2; // m from the centre line to the sidewalk's outer edge
export const WATER_LEVEL = 0; // m, the river's and the ponds' surface
const SPACING_X = 150; // m between east-west streets
const SPACING_Z = 190; // m between north-south streets
// The sunny town is a denser, more regular grid of smaller blocks, as in the reference diorama.
const DAY_SPACING_X = 100;
const DAY_SPACING_Z = 120;
const DAY_WARP = 0.65; // its streets wind less
const RIVER_SPACING = 640; // m between rivers
const RIVER_DEPTH = 1.3; // m of water in the middle of the river (shallow enough to ford)

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// How high a sunny-town block's plinth stands (m), by its row and column of the street grid.
const RAISES = [0, 0, 1.2, 1.8, 2.6, 3.4];
function blockRaise(i, j) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + 0x5bd1e995) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return RAISES[((h ^ (h >>> 16)) >>> 0) % RAISES.length];
}

// Whether street k of family fi jumps river kr in the sunny town (about half do).
function riverGap(fi, k, kr) {
  let h = (Math.imul(k * 2 + fi, 2246822519) + Math.imul(kr, 3266489917) + 0x2f6b) | 0;
  h = Math.imul(h ^ (h >>> 15), 668265263);
  return ((h ^ (h >>> 13)) >>> 0) % 2 === 0;
}

// Which bank (the sign of the river's field) the kicker of a river gap is on.
function riverGapSide(fi, k, kr) {
  let h = (Math.imul(k * 2 + fi, 374761393) + Math.imul(kr, 668265263) + 0x51ed) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) % 2 === 0 ? 1 : -1;
}

// Sunny town stunt parks: about one town block in seven (never the origin's).
function isPark(i, j) {
  if (i === 0 && j === 0) return false;
  let h = (Math.imul(i, 668265263) + Math.imul(j, 374761393) + 0x27d4eb2d) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  return ((h ^ (h >>> 13)) >>> 0) % 7 === 0;
}

// A stunt park's ground (m above the block's ground) at (px, pz) from the block's middle (along
// the east-west streets' field, then the north-south one's; both about metres) and `e` m in from
// the sidewalk. The park is a raised slab of concrete with banked quarter-pipe walls around the
// edge (gaps in the middle of each side to drive in), a tabletop down the middle with ramps at
// both ends, kickers beyond it launching toward the banks, a ring of rollers (a pump track)
// around it all, a mogul field on one side and a bowl on the other.
export const PARK_FLOOR = 1.6;
export function parkHeight(px, pz, e) {
  const sideX = DAY_SPACING_X / 2 - Math.abs(px); // to the east-west streets
  const sideZ = DAY_SPACING_Z / 2 - Math.abs(pz);
  const along = sideX < sideZ ? Math.abs(pz) : Math.abs(px);
  const gate = smoothstep(10, 7, along);
  const bank = 3.6 * smoothstep(10, 1.2, e) ** 1.5 * (1 - gate);
  const ax = Math.abs(px);
  const az = Math.abs(pz);
  const table = 2.2 * Math.min(1, Math.max(0, (20 - az) / 9)) * smoothstep(7.5, 6.2, ax);
  const lip = az - 30; // kickers rise outward to a lip at |pz| 30
  const kicker = ax < 4.5 && lip > -6 && lip < 0.8 ? 1.6 * (lip <= 0 ? (1 + lip / 6) ** 1.4 : smoothstep(0.8, 0, lip)) * smoothstep(4.5, 3.5, ax) : 0;
  const ring = Math.hypot(px / 33, pz / 43);
  const theta = Math.atan2(pz / 43, px / 33);
  const rollers = ring > 0.84 && ring < 1.02 ? 0.75 * Math.sin(theta * 16) ** 2 * smoothstep(0.84, 0.88, ring) * smoothstep(1.02, 0.98, ring) : 0;
  const moguls = px > 11 && px < 26 && az < 15 ? 0.55 * Math.sin((px - 11) * 0.63) ** 2 * Math.cos(pz * 0.52) ** 2 * smoothstep(15, 12, az) * smoothstep(26, 23, px) : 0;
  const r = Math.hypot(px + 19, pz);
  const bowl = r < 8.5 ? -2.4 * (1 - (r / 8.5) ** 2) ** 1.4 : 0;
  return PARK_FLOOR + bank + table + kicker + rollers + moguls + bowl;
}

// The middle (t along x or z) of the driveway on street k of family fi, side `side`, in the 70 m
// stretch around t, or null.
function drivewayAt(fi, k, t, side) {
  const m = Math.floor(t / 70);
  let h = (Math.imul(m, 2654435761) + Math.imul(k * 4 + fi * 2 + (side > 0 ? 1 : 0), 40503) + 0x9e37) | 0;
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  const r = ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  return r < 0.2 ? (m + 0.2 + 0.6 * (r / 0.2)) * 70 : null;
}

// A street's jump at `t` along it (x or z): one in two 90 m stretches of each street has
// one, a smooth crest or a tabletop with a flat top.
export const JUMP_SPACING = 90;
// The jump in stretch m of street k of family fi: its middle t0 (along x or z) and whether it is a
// crest (else a tabletop), with `reach`, how far either side of t0 it runs; or null.
export function streetJumpAt(fi, k, m) {
  let h = (Math.imul(m, 374761393) + Math.imul(k * 2 + fi, 668265263) + 0x165667b1) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  const r = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  if (r > 0.5) return null;
  return { t0: (m + 0.5) * JUMP_SPACING + (r / 0.5 - 0.5) * 30, crest: r < 0.25, reach: r < 0.25 ? 7 : 10 };
}

function streetJump(fi, k, t) {
  const m = Math.floor(t / JUMP_SPACING);
  let lift = 0;
  for (const mm of [m - 1, m, m + 1]) {
    const jump = streetJumpAt(fi, k, mm);
    if (!jump) continue;
    const u = Math.abs(t - jump.t0);
    if (jump.crest) {
      // Crest: 1.4 m over 14 m.
      if (u < 7) lift = Math.max(lift, 1.4 * Math.cos((Math.PI * u) / 14) ** 2);
    } else if (u < 10) {
      // Tabletop: a curved 7 m kicker up to 1.7 m (steepening to about 24 degrees at the lip), a
      // 6 m flat top, and the same curve down the far side to land on.
      lift = Math.max(lift, 1.7 * Math.min(1, (10 - u) / 7) ** 1.8);
    }
  }
  return lift;
}

// Stepped ramp: level ledges joined by steep risers (granite outcrops, terraced hillsides).
function terrace(v, steps, riser = 0.7) {
  const s = v * steps;
  const k = Math.floor(s);
  const f = s - k;
  return (k + (f < riser ? 0 : smoothstep(riser, 1, f))) / steps;
}

// `world`: 'town' (the dark town, at night) or 'daytown' (the sunny town, by day, with the
// modelled buildings of the kit, see terrain/buildings.js).
export function createTownField(seed = 31, world = 'town') {
  const day = world === 'daytown';
  const SX = day ? DAY_SPACING_X : SPACING_X;
  const SZ = day ? DAY_SPACING_Z : SPACING_Z;
  const warp = day ? DAY_WARP : 1;
  const rand = mulberry32(seed);
  const warpA = createNoise2D(rand);
  const warpB = createNoise2D(rand);
  const riverWarp = createNoise2D(rand);
  const floorNoise = createNoise2D(rand);
  const districtNoise = createNoise2D(rand);
  const ridgeNoise = createNoise2D(rand);
  const hillNoise = createNoise2D(rand);
  const lakeNoise = createNoise2D(rand);
  const bumpNoise = createNoise2D(rand);

  // Warped coordinates across each family; a road (or the river) is where one is a multiple of
  // its spacing. The east-west family is shifted so a street runs through the origin.
  const a0 = warp * (38 * warpA(0, 0) + 10 * warpB(0, 0));
  const acrossX = (x, z) => z + warp * (38 * warpA(x * 0.005, z * 0.004) + 10 * warpB(x * 0.017, z * 0.017)) - a0;
  const acrossZ = (x, z) => x + warp * (45 * warpB(x * 0.004 + 40, z * 0.0055) + 9 * warpA(x * 0.018 + 9, z * 0.018));
  const acrossR = (x, z) => 0.6 * x - 0.8 * z + 110 * riverWarp(x * 0.0022, z * 0.0022) + 28 * riverWarp(x * 0.008 + 3, z * 0.008);
  const OFFSET_Z = SZ * 0.41;
  // The river runs half its spacing away from the origin.
  const OFFSET_R = RIVER_SPACING / 2 - acrossR(0, 0);

  // Signed distance (m) to the nearest line of one family, and the unit gradient across it.
  function family(across, x, z, spacing, offset) {
    const e = 0.5;
    const a = across(x, z) + offset;
    const gx = (across(x + e, z) - across(x - e, z)) / (2 * e);
    const gz = (across(x, z + e) - across(x, z - e)) / (2 * e);
    const g = Math.hypot(gx, gz) || 1;
    const k = Math.round(a / spacing);
    return { d: (a - k * spacing) / g, gx: gx / g, gz: gz / g };
  }
  const streets = (x, z) => [family(acrossX, x, z, SX, 0), family(acrossZ, x, z, SZ, OFFSET_Z)];
  const nearest = (both) => (Math.abs(both[0].d) <= Math.abs(both[1].d) ? both[0] : both[1]);

  const riverAt = (x, z) => family(acrossR, x, z, RIVER_SPACING, OFFSET_R);
  const riverHalfAt = (x, z) => 8 + 3.5 * riverWarp(x * 0.02 + 17, z * 0.02);
  // The rolling ground the streets are graded on, sinking into a broad valley along the river
  // (so the streets run down to it and cross it just above the water).
  const floorAt = (x, z) => {
    const h = 4.5 + 3 * floorNoise(x * 0.004, z * 0.004) + 1.2 * floorNoise(x * 0.013 + 7, z * 0.013);
    const valley = 1 - smoothstep(14, 80, Math.abs(riverAt(x, z).d));
    return h + (Math.min(h, 1.6) - h) * valley;
  };
  // 0 in town, 1 in the wild districts (forest and mountains). The origin is in town.
  // The district field is shifted so the origin lies well inside a town district.
  const rawDistrict = (x, z) => districtNoise(x * 0.0026, z * 0.0026) + 0.3 * districtNoise(x * 0.009 + 13, z * 0.009);
  let shift = 0;
  while (rawDistrict(shift, 0) > -0.45) shift += 23;
  const wildAt = (x, z) => smoothstep(0.05, 0.4, rawDistrict(x + shift, z));

  function sample(x, z) {
    const both = streets(x, z);
    const r = nearest(both);
    const other = r === both[0] ? both[1] : both[0];
    const dist = Math.abs(r.d);
    const wild = wildAt(x, z);
    // Sunny town: some blocks are stunt parks (see `parkHeight`), away from the wild and the river.
    const block = day ? [Math.floor(acrossX(x, z) / SX), Math.floor((acrossZ(x, z) + OFFSET_Z) / SZ)] : null;
    const park = day && isPark(block[0], block[1]) ? (1 - smoothstep(0.15, 0.3, wild)) * (1 - smoothstep(-60, -40, -(Math.abs(riverAt(x, z).d) - riverHalfAt(x, z)))) : 0;
    // Streets are graded level from side to side: near a street the floor is taken at its centre
    // line, blending into the local floor further out (and both gradings where two streets meet).
    let sum = 0;
    let weight = 0;
    let most = 0;
    for (const f of both) {
      const w = 1 - smoothstep(KERB + 1, 24, Math.abs(f.d));
      if (w <= 0) continue;
      sum += w * floorAt(x - f.gx * f.d, z - f.gz * f.d);
      weight += w;
      most = Math.max(most, w);
    }
    if (most < 1) {
      sum += (1 - most) * floorAt(x, z);
      weight += 1 - most;
    }
    let h = sum / weight;
    // Asphalt with a slight crown.
    if (dist < ROAD_HALF_WIDTH + 0.3) h -= 0.04 * (dist / ROAD_HALF_WIDTH) ** 2;
    const off = smoothstep(KERB, 14, dist);
    h += off * 0.25 * bumpNoise(x * 0.07, z * 0.07);

    // Town: terraced hills in the middle of some blocks, with rock faces between the terraces.
    const hill = Math.max(0, hillNoise(x * 0.011, z * 0.011));
    const inner = smoothstep(24, 52, dist);
    const townHill = inner * (1 - wild) * (1 - park) * terrace(Math.min(1, hill * 1.4), 3, 0.6) * 11;
    // Wild districts: forested foothills, then ridged granite mountains in the middle of the blocks.
    const foot = smoothstep(9, 46, dist) * wild * (3 + 7 * (0.5 + 0.5 * hillNoise(x * 0.016 + 5, z * 0.016)));
    const ridge = 1 - Math.abs(ridgeNoise(x * 0.008, z * 0.008));
    const crag = 0.5 + 0.5 * ridgeNoise(x * 0.03 + 11, z * 0.03);
    const mass = smoothstep(18, 58, dist) * smoothstep(0.3, 0.75, wild);
    // The ledges' edges wander (noise added before terracing), so the outcrops are not contour rings.
    const wander = 0.06 * bumpNoise(x * 0.045 + 31, z * 0.045);
    const mountain = mass > 0 ? mass * (terrace(Math.max(0, Math.min(1, ridge ** 1.5 * (0.75 + 0.35 * crag) + wander)), 6, 0.55) * 42 + 4 * crag) : 0;
    h += townHill + foot + mountain;
    // Sunny town: each block stands on its own plinth, raised a little behind a stone retaining
    // wall along the sidewalk (some blocks stay at street level), as the reference's blocks do.
    let jump = 0;
    let parkLift = 0;
    let driveway = 0;
    if (day) {
      const raise = blockRaise(block[0], block[1]);
      const away = 1 - smoothstep(20, 45, Math.abs(riverAt(x, z).d) - riverHalfAt(x, z));
      // Here and there a driveway ramps up through the retaining wall onto a raised block (1 in 5),
      // into the gardens behind the rows (which leave it clear, see terrain/buildings.js).
      if (raise > 0) {
        const fi = r === both[0] ? 0 : 1;
        const k = Math.round((fi === 0 ? acrossX(x, z) : acrossZ(x, z) + OFFSET_Z) / (fi === 0 ? SX : SZ));
        const t0 = drivewayAt(fi, k, fi === 0 ? x : z, r.d > 0 ? 1 : -1);
        if (t0 !== null && Math.abs(other.d) > 20) driveway = smoothstep(4.5, 3.2, Math.abs((fi === 0 ? x : z) - t0)) * (1 - smoothstep(KERB + 26, KERB + 30, dist));
      }
      const wall = smoothstep(KERB + 0.35, KERB + 1.15, dist);
      const ramp = smoothstep(KERB + 0.35, KERB + 0.35 + raise * 5, dist);
      h += raise * (wall + (ramp - wall) * driveway) * (1 - smoothstep(0.2, 0.5, wild)) * (1 - away) * (1 - park);
      // The stunt parks' banks, tabletop, kickers, moguls and bowl, on the paving behind the sidewalks.
      if (park > 0) h += (parkLift = park * smoothstep(KERB + 0.3, KERB + 1.0, dist) * parkHeight(acrossX(x, z) - (block[0] + 0.5) * SX, acrossZ(x, z) + OFFSET_Z - (block[1] + 0.5) * SZ, dist - KERB));
      // Jumps on the streets: crests and tabletops on some straights, clear of the junctions.
      for (let fi = 0; fi < 2; fi++) {
        const f = both[fi];
        const across = Math.abs(f.d);
        if (across > KERB + 0.5) continue;
        const o = both[1 - fi];
        const k = Math.round((fi === 0 ? acrossX(x, z) : acrossZ(x, z) + OFFSET_Z) / (fi === 0 ? SX : SZ));
        const t = fi === 0 ? x : z;
        const lift = streetJump(fi, k, t) * (1 - smoothstep(KERB - 0.8, KERB + 0.4, across)) * smoothstep(18, 28, Math.abs(o.d)) * (1 - smoothstep(0.2, 0.4, wild)) * smoothstep(30, 45, Math.abs(riverAt(x, z).d) - riverHalfAt(x, z));
        jump = Math.max(jump, lift);
      }
      h += jump;
    }

    // Ponds in the parks and the wild lowlands (not in the mountains).
    const pondShape = lakeNoise(x * 0.011, z * 0.011);
    const pond = smoothstep(0.42, 0.56, pondShape) * smoothstep(17, 27, dist) * (1 - smoothstep(0.5, 0.8, wild)) * (1 - smoothstep(0.5, 3, townHill)) * (1 - park);
    if (pond > 0) h += (WATER_LEVEL - 1.4 - h) * pond;

    // The river: a valley floor near the water, then a channel cut to below the water level. It
    // passes under the streets, which cross it on low embankments.
    const river = riverAt(x, z);
    const riverDist = Math.abs(river.d);
    const halfWidth = riverHalfAt(x, z);
    // Sunny town: about half the streets jump the river instead of crossing on an embankment. A
    // curved kicker rises 3.2 m over 18 m on one bank to a lip (about 19 degrees) where the channel
    // starts; the road is cut through, its banks steep, and the far bank's road is the landing.
    // (Coming the other way the road just ends at the water, which is shallow enough to ford.)
    let gap = 0;
    if (day && dist < KERB + 6 && riverDist < halfWidth + 27) {
      const fi = r === both[0] ? 0 : 1;
      const k = Math.round((fi === 0 ? acrossX(x, z) : acrossZ(x, z) + OFFSET_Z) / (fi === 0 ? SX : SZ));
      const kr = Math.round((acrossR(x, z) + OFFSET_R) / RIVER_SPACING);
      // Only where the street crosses the river squarely enough, not where it runs along a bank:
      // judged where it crosses the middle of the river (one step along the street from here), so
      // the whole approach agrees.
      const square = (px, pz) => {
        const st = nearest(streets(px, pz));
        const rv = riverAt(px, pz);
        return { c: -st.gz * rv.gx + st.gx * rv.gz, d: rv.d };
      };
      const here = square(x, z);
      const step = Math.abs(here.c) > 0.3 ? -here.d / here.c : 0;
      const there = square(x - r.gz * step, z + r.gx * step);
      const squareness = smoothstep(0.55, 0.7, Math.abs(there.c));
      if (riverGap(fi, k, kr) && squareness > 0) {
        // (Wider than the street, so a car flying off a bend still lands on the ramp.)
        gap = (1 - smoothstep(KERB + 2.5, KERB + 5.5, dist)) * squareness;
        // The kicker is on one bank; the far bank's road stays low, a flat landing beyond the channel.
        const out = riverDist - (halfWidth + 0.6);
        if (out > 0 && out < 18 && Math.sign(river.d) === riverGapSide(fi, k, kr)) h += gap * 3.2 * (1 - out / 18) ** 1.9;
      }
    }
    if (riverDist < halfWidth + 4.5) {
      const bank = 1 - smoothstep(halfWidth, halfWidth + 4.5 - 3.9 * gap, riverDist);
      const cut = bank * Math.max(gap, smoothstep(ROAD_HALF_WIDTH + 2, KERB + 4, dist));
      const bed = WATER_LEVEL - RIVER_DEPTH * (1 - (Math.min(riverDist, halfWidth) / halfWidth) ** 2) - 0.15;
      h += (bed - h) * cut;
    }

    const road = 1 - smoothstep(ROAD_HALF_WIDTH - 0.1, ROAD_HALF_WIDTH + 0.4, dist);
    return { h, road, side: r.d, dist, other: Math.abs(other.d), gx: r.gx, gz: r.gz, wild, mountain, townHill, riverDist, riverHalf: halfWidth, park, parkLift, jump, driveway };
  }

  const heightAt = (x, z) => sample(x, z).h;
  heightAt.sample = sample;
  // What the tyres stand on: road (asphalt and paving, hard and grippy) and rock (granite and the
  // terraces' faces); the rest is grass and soil.
  heightAt.groundAt = (x, z, out = { road: 0, rock: 0 }) => {
    const s = sample(x, z);
    out.road = Math.max(1 - smoothstep(KERB - 0.3, KERB + 0.3, s.dist), s.park ?? 0, s.driveway ?? 0);
    out.rock = smoothstep(4, 12, s.mountain) * (1 - out.road);
    return out;
  };
  heightAt.roadDistance = (x, z) => Math.abs(nearest(streets(x, z)).d);
  // Heading (radians about +y, 0 = +x) along the street through a point.
  heightAt.roadHeading = (x, z) => {
    const r = nearest(streets(x, z));
    const dx = -r.gz;
    const dz = r.gx;
    return dx >= 0 ? Math.atan2(-dz, dx) : Math.atan2(dz, -dx);
  };
  // How deep the water is at a point (m; negative on dry land). The minimap draws it as a lake.
  heightAt.lakeInside = (x, z) => WATER_LEVEL - heightAt(x, z);
  // The streets and sidewalks are paved: no soil thrown, piled or rutted there (systems/soil.js,
  // systems/tracks.js), asphalt grip and no loose stones for the tyres (tire/config.js).
  heightAt.bareAt = (x, z) => heightAt.roadDistance(x, z) < KERB || (day && sample(x, z).park > 0.5);
  heightAt.paved = true;
  heightAt.waterLevel = WATER_LEVEL;
  heightAt.wildAt = wildAt;
  // The two street families, for walking along a street (terrain/buildings.js): a street is where
  // `across` is a multiple of `spacing`; it runs roughly along x (`alongX`) or z.
  heightAt.streetFamilies = [
    { across: acrossX, spacing: SX, alongX: true },
    { across: (x, z) => acrossZ(x, z) + OFFSET_Z, spacing: SZ, alongX: false },
  ];
  // The sunny town's layout, for placing things on it (terrain/props.js): its blocks' size, which
  // are stunt parks, and the street jumps.
  heightAt.blocks = { sizeX: SX, sizeZ: SZ, isPark: (i, j) => day && isPark(i, j) };
  heightAt.town = true;
  heightAt.world = world;
  heightAt.buildingKit = world === 'daytown';
  return heightAt;
}
