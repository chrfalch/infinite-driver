// Isometric town: a diorama-like world of winding asphalt streets with sidewalks, rows of houses
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
const RIVER_SPACING = 640; // m between rivers
const RIVER_DEPTH = 1.3; // m of water in the middle of the river (shallow enough to ford)

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Stepped ramp: level ledges joined by steep risers (granite outcrops, terraced hillsides).
function terrace(v, steps, riser = 0.7) {
  const s = v * steps;
  const k = Math.floor(s);
  const f = s - k;
  return (k + (f < riser ? 0 : smoothstep(riser, 1, f))) / steps;
}

export function createTownField(seed = 31) {
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
  const a0 = 38 * warpA(0, 0) + 10 * warpB(0, 0);
  const acrossX = (x, z) => z + 38 * warpA(x * 0.005, z * 0.004) + 10 * warpB(x * 0.017, z * 0.017) - a0;
  const acrossZ = (x, z) => x + 45 * warpB(x * 0.004 + 40, z * 0.0055) + 9 * warpA(x * 0.018 + 9, z * 0.018);
  const acrossR = (x, z) => 0.6 * x - 0.8 * z + 110 * riverWarp(x * 0.0022, z * 0.0022) + 28 * riverWarp(x * 0.008 + 3, z * 0.008);
  const OFFSET_Z = SPACING_Z * 0.41;
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
  const streets = (x, z) => [family(acrossX, x, z, SPACING_X, 0), family(acrossZ, x, z, SPACING_Z, OFFSET_Z)];
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
    const townHill = inner * (1 - wild) * terrace(Math.min(1, hill * 1.4), 3, 0.6) * 11;
    // Wild districts: forested foothills, then ridged granite mountains in the middle of the blocks.
    const foot = smoothstep(9, 46, dist) * wild * (3 + 7 * (0.5 + 0.5 * hillNoise(x * 0.016 + 5, z * 0.016)));
    const ridge = 1 - Math.abs(ridgeNoise(x * 0.008, z * 0.008));
    const crag = 0.5 + 0.5 * ridgeNoise(x * 0.03 + 11, z * 0.03);
    const mass = smoothstep(18, 58, dist) * smoothstep(0.3, 0.75, wild);
    // The ledges' edges wander (noise added before terracing), so the outcrops are not contour rings.
    const wander = 0.06 * bumpNoise(x * 0.045 + 31, z * 0.045);
    const mountain = mass > 0 ? mass * (terrace(Math.max(0, Math.min(1, ridge ** 1.5 * (0.75 + 0.35 * crag) + wander)), 6, 0.55) * 42 + 4 * crag) : 0;
    h += townHill + foot + mountain;

    // Ponds in the parks and the wild lowlands (not in the mountains).
    const pondShape = lakeNoise(x * 0.011, z * 0.011);
    const pond = smoothstep(0.42, 0.56, pondShape) * smoothstep(17, 27, dist) * (1 - smoothstep(0.5, 0.8, wild)) * (1 - smoothstep(0.5, 3, townHill));
    if (pond > 0) h += (WATER_LEVEL - 1.4 - h) * pond;

    // The river: a valley floor near the water, then a channel cut to below the water level. It
    // passes under the streets, which cross it on low embankments.
    const riverDist = Math.abs(riverAt(x, z).d);
    const halfWidth = riverHalfAt(x, z);
    if (riverDist < halfWidth + 4.5) {
      const cut = (1 - smoothstep(halfWidth, halfWidth + 4.5, riverDist)) * smoothstep(ROAD_HALF_WIDTH + 2, KERB + 4, dist);
      const bed = WATER_LEVEL - RIVER_DEPTH * (1 - (Math.min(riverDist, halfWidth) / halfWidth) ** 2) - 0.15;
      h += (bed - h) * cut;
    }

    const road = 1 - smoothstep(ROAD_HALF_WIDTH - 0.1, ROAD_HALF_WIDTH + 0.4, dist);
    return { h, road, side: r.d, dist, other: Math.abs(other.d), gx: r.gx, gz: r.gz, wild, mountain, townHill, riverDist, riverHalf: halfWidth };
  }

  const heightAt = (x, z) => sample(x, z).h;
  heightAt.sample = sample;
  // What the tyres stand on: road (asphalt and paving, hard and grippy) and rock (granite and the
  // terraces' faces); the rest is grass and soil.
  heightAt.groundAt = (x, z, out = { road: 0, rock: 0 }) => {
    const s = sample(x, z);
    out.road = 1 - smoothstep(KERB - 0.3, KERB + 0.3, s.dist);
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
  heightAt.bareAt = (x, z) => heightAt.roadDistance(x, z) < KERB;
  heightAt.paved = true;
  heightAt.waterLevel = WATER_LEVEL;
  heightAt.wildAt = wildAt;
  heightAt.town = true;
  heightAt.world = 'town';
  return heightAt;
}
