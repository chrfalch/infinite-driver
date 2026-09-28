// Red-rock canyon country: winding gravel roads along valley floors, gentle banks and foothills
// either side, layered sandstone mesas and hoodoo towers beyond. Everything comes from one
// deterministic height function, so physics colliders, the GPU tyre ground grid, tracks, soil and
// the render mesh all agree.
//
// Roads are the zero lines of two warped periodic fields: one family runs roughly east-west, the
// other north-south, so they meander and cross. The distance to the nearest road (|f| / |grad f|)
// shapes the valley around it. The origin is always on a road.
import { createNoise2D } from 'simplex-noise';
import { mulberry32 } from './height.js';

export const ROAD_HALF_WIDTH = 3.2; // m, graded surface either side of the centre line
const RUT_OFFSET = 1.05; // m from the centre line (half the car's track)
const SPACING_X = 330; // m between east-west roads
const SPACING_Z = 450; // m between north-south roads

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Stepped (terraced) ramp: flat ledges joined by steep risers, for layered sandstone.
function terrace(v, steps) {
  const s = v * steps;
  const k = Math.floor(s);
  const f = s - k;
  const riser = f < 0.72 ? 0 : smoothstep(0.72, 1, f);
  return (k + riser) / steps;
}

function hash2(ix, iz, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function createCanyonField(seed = 2024) {
  const rand = mulberry32(seed);
  const warpA = createNoise2D(rand);
  const warpB = createNoise2D(rand);
  const floorNoise = createNoise2D(rand);
  const hillNoise = createNoise2D(rand);
  const mesaNoise = createNoise2D(rand);
  const edgeNoise = createNoise2D(rand);
  const bumpNoise = createNoise2D(rand);

  // Warped coordinate across each road family; roads are where it is a multiple of the spacing.
  const wa0 = warpA(0, 0);
  const acrossX = (x, z) => z + 70 * (warpA(x * 0.0032, z * 0.0021) - wa0) + 22 * warpB(x * 0.011, z * 0.011);
  const acrossZ = (x, z) => x + 90 * warpB(x * 0.0019 + 40, z * 0.0028) + 18 * warpA(x * 0.012 + 9, z * 0.012);
  // Offset the north-south family so it does not also cross the origin.
  const OFFSET_Z = SPACING_Z * 0.37;

  // Signed distance (m) to the nearest road of one family, and the road's direction.
  function family(across, x, z, spacing, offset) {
    const e = 0.5;
    const a = across(x, z) + offset;
    const gx = (across(x + e, z) - across(x - e, z)) / (2 * e);
    const gz = (across(x, z + e) - across(x, z - e)) / (2 * e);
    const g = Math.hypot(gx, gz) || 1;
    const k = Math.round(a / spacing);
    return { d: (a - k * spacing) / g, gx: gx / g, gz: gz / g };
  }

  function roads(x, z) {
    return [family(acrossX, x, z, SPACING_X, 0), family(acrossZ, x, z, SPACING_Z, OFFSET_Z)];
  }
  function road(x, z) {
    const [a, b] = roads(x, z);
    return Math.abs(a.d) <= Math.abs(b.d) ? a : b;
  }

  // Everything the renderer needs at a point; heightAt uses only .h.
  function sample(x, z) {
    const both = roads(x, z);
    const r = Math.abs(both[0].d) <= Math.abs(both[1].d) ? both[0] : both[1];
    const dist = Math.abs(r.d);
    // Valley floor: long gentle undulation, so roads climb and dip a little. Across the road and its
    // banks the floor height is taken at the road's centre line, so the road is graded level side to
    // side, then blends into the local floor further out.
    const floorAt = (px, pz) => 4 * floorNoise(px * 0.0035, pz * 0.0035) + 1.5 * floorNoise(px * 0.011 + 7, pz * 0.011);
    // Where two roads meet, both gradings blend so there is no step.
    let sum = 0;
    let weight = 0;
    let most = 0;
    for (const f of both) {
      const w = 1 - smoothstep(ROAD_HALF_WIDTH + 1, 22, Math.abs(f.d));
      if (w <= 0) continue;
      sum += w * floorAt(x - f.gx * f.d, z - f.gz * f.d);
      weight += w;
      most = Math.max(most, w);
    }
    if (most < 1) {
      sum += (1 - most) * floorAt(x, z);
      weight += 1 - most;
    }
    const floor = sum / weight;
    let h = floor;
    // Road: slight crown and two worn wheel ruts.
    let rutWear = 0;
    if (dist < ROAD_HALF_WIDTH + 0.5) {
      const rut = Math.abs(dist - RUT_OFFSET);
      rutWear = Math.exp(-(rut * rut) / 0.05);
      h -= 0.035 * rutWear;
      h -= 0.03 * (dist / ROAD_HALF_WIDTH) ** 2;
    }
    // Banks: a gentle rise off the road edge.
    const bank = smoothstep(ROAD_HALF_WIDTH, 13, dist);
    h += bank * 0.9;
    // Foothills: rolling slopes dotted with shrubs.
    const foot = smoothstep(10, 46, dist);
    const hill = 0.5 + 0.5 * hillNoise(x * 0.012, z * 0.012);
    h += foot * (4 + 9 * hill) + bank * 0.35 * bumpNoise(x * 0.09, z * 0.09);
    // Sandstone mesas: stepped cliffs further out, with wiggly edges.
    const edge = 44 + 16 * edgeNoise(x * 0.02, z * 0.02);
    const cliff = smoothstep(edge, edge + 22, dist);
    let rock = 0;
    if (cliff > 0) {
      const m = 0.55 + 0.45 * mesaNoise(x * 0.006, z * 0.006);
      rock = cliff * terrace(Math.min(1, m * (0.6 + 0.6 * cliff)), 5) * 38;
      h += rock;
    }
    // Hoodoos: sandstone towers on a 36 m grid, only on the foothills beside the valley.
    let hoodoo = 0;
    if (dist > 16 && dist < 60) {
      const cell = 36;
      const cx = Math.floor(x / cell);
      const cz = Math.floor(z / cell);
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const hx = cx + i;
          const hz = cz + j;
          if (hash2(hx, hz, seed) > 0.42) continue;
          const px = (hx + 0.2 + 0.6 * hash2(hx, hz, seed + 1)) * cell;
          const pz = (hz + 0.2 + 0.6 * hash2(hx, hz, seed + 2)) * cell;
          const radius = 2.6 + 3.2 * hash2(hx, hz, seed + 3);
          const q = Math.hypot(x - px, z - pz) / radius;
          if (q >= 1.25) continue;
          // Steep sides, a slightly domed cap, a flared foot.
          const tall = 8 + 12 * hash2(hx, hz, seed + 4);
          const body = q < 1 ? 1 - q ** 8 : 0;
          const foot = 0.25 * smoothstep(1.25, 0.9, q);
          hoodoo = Math.max(hoodoo, tall * Math.max(body, foot));
        }
      }
      h += hoodoo * smoothstep(16, 24, dist) * smoothstep(60, 52, dist);
    }
    return { h, road: 1 - smoothstep(ROAD_HALF_WIDTH - 0.4, ROAD_HALF_WIDTH + 1.2, dist), rut: rutWear, dist, rock: rock + hoodoo, cliff };
  }

  const heightAt = (x, z) => sample(x, z).h;
  heightAt.sample = sample;
  heightAt.roadDistance = (x, z) => Math.abs(road(x, z).d);
  // Heading (radians about +y, 0 = +x) along the road through a point.
  heightAt.roadHeading = (x, z) => {
    const r = road(x, z);
    const dx = -r.gz;
    const dz = r.gx;
    return dx >= 0 ? Math.atan2(-dz, dx) : Math.atan2(dz, -dx);
  };
  heightAt.canyon = true;
  heightAt.world = 'canyon';
  return heightAt;
}
