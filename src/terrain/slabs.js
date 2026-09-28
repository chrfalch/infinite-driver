// Sandstone slabs in the dry river bed: a jittered cell pattern (Worley). Each cell is either sand
// or a plate standing a little proud of it. The height function (terrain/riverbed.js) raises the
// plates, and the terrain shader draws the same cells per pixel, so plate edges and cracks stay
// crisp on the 1 m ground mesh.
//
// Two copies of the cell maths: JavaScript (height) and TSL (terrain shader). Keep them in step.
import { Fn, If, float, int, mix, positionWorld, smoothstep, uint, vec2, vec3, vec4 } from 'three/tsl';

export const SLAB_CELL = 4.2; // m, slab size
export const SLAB_SEED = 4711;
export const SLAB_SAND_SHARE = 0.5; // cells that are sand, not a plate
export const SLAB_INSET = 0.35; // m of sand between a plate and its cell border

export function slabHash(ix, iz, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Nearest and second-nearest cell centres to (x, z): { d1, d2, hx, hz, px, pz }.
export function slabCells(x, z) {
  const cx = Math.floor(x / SLAB_CELL);
  const cz = Math.floor(z / SLAB_CELL);
  let d1 = Infinity;
  let d2 = Infinity;
  let best = null;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const hx = cx + i;
      const hz = cz + j;
      const px = (hx + 0.15 + 0.7 * slabHash(hx, hz, SLAB_SEED)) * SLAB_CELL;
      const pz = (hz + 0.15 + 0.7 * slabHash(hx, hz, SLAB_SEED + 1)) * SLAB_CELL;
      const d = Math.hypot(x - px, z - pz);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        best = { hx, hz, px, pz };
      } else if (d < d2) d2 = d;
    }
  }
  return { d1, d2, ...best };
}

// TSL hash, the same as slabHash (uint maths wraps like Math.imul).
const seedTerm = (seed) => uint(Math.imul(seed, 982451653) >>> 0);
function hashTsl(ix, iz, seed) {
  let h = ix.mul(uint(374761393)).add(iz.mul(uint(668265263))).add(seedTerm(seed));
  h = h.bitXor(h.shiftRight(uint(13))).mul(uint(1274126177));
  h = h.bitXor(h.shiftRight(uint(16)));
  return float(h).div(4294967296);
}

// TSL: vec3(plate, edge, tint) at this pixel: plate is 1 for a plate cell and 0 for sand; edge is the distance
// (m) inside the plate's edge (negative in the sand round it). Also the plate's tint (0..1).
export const slabCellsTsl = Fn(() => {
  const p = positionWorld.xz;
  const c = p.div(SLAB_CELL).floor();
  const d1 = float(1e9).toVar();
  const d2 = float(1e9).toVar();
  const pick = float(0).toVar();
  const tint = float(0).toVar();
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const n = c.add(vec2(i, j));
      const ix = uint(int(n.x));
      const iz = uint(int(n.y));
      const o = vec2(hashTsl(ix, iz, SLAB_SEED), hashTsl(ix, iz, SLAB_SEED + 1)).mul(0.7).add(0.15);
      const d = p.sub(n.add(o).mul(SLAB_CELL)).length();
      If(d.lessThan(d1), () => {
        d2.assign(d1);
        d1.assign(d);
        pick.assign(hashTsl(ix, iz, SLAB_SEED + 2));
        tint.assign(hashTsl(ix, iz, SLAB_SEED + 6));
      }).ElseIf(d.lessThan(d2), () => {
        d2.assign(d);
      });
    }
  }
  const plate = pick.greaterThanEqual(SLAB_SAND_SHARE).select(float(1), float(0));
  return vec3(plate, d2.sub(d1).mul(0.5).sub(SLAB_INSET), tint);
});

// TSL: the slab colour at this pixel and how much of it shows (vec4: rgb, amount). Plates are
// sandstone, from pale grey-cream to ochre, with a darker weathered side round the edge.
export const slabColorTsl = Fn(() => {
  const s = slabCellsTsl();
  const edge = s.y; // m inside the plate's edge (negative: sand round it)
  const base = mix(vec3(0.6, 0.53, 0.41), vec3(0.64, 0.4, 0.18), s.z.mul(s.z));
  const side = smoothstep(0.18, 0.02, edge).mul(0.45);
  const amount = smoothstep(-0.02, 0.03, edge).mul(s.x);
  return vec4(base.mul(side.oneMinus()), amount);
});
