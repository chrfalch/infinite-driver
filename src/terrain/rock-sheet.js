// The dry river's rock sheet (terrain/riverbed.js) as its own fine mesh over the coarse 1 m ground:
// one connected, flat-shaded surface on a 25 cm grid, covering only the cells near the bed, each
// facet tinted by the boulder on top (render/rock-surface.js draws it). The physics side builds a
// coarser collider from the same grid (rockSheetTrimesh). Plain maths, no renderer, so both
// workers can use it.
import { CHUNK_SIZE } from './chunk.js';
import { ROCK_REACH } from './riverbed.js';

export const ROCK_SHEET_STEP = 0.25; // m, drawn mesh
export const ROCK_COLLIDER_STEP = 0.5; // m, physics collider

// Samples the sheet on a `step` grid over the chunk, only in the 1 m cells that the sheet reaches.
// Returns the grid heights and ids (NaN where unsampled) and the list of covered grid cells.
// `rows`: the metre rows [from, to) of the chunk to cover (a band, so the work can be split).
function sampleSheet(heightAt, cx, cz, step, rows = [0, CHUNK_SIZE]) {
  const per = Math.round(1 / step); // grid cells per metre
  const n = CHUNK_SIZE * per + 1;
  const heights = new Float32Array(n * n).fill(NaN);
  const ids = new Float32Array(n * n);
  const x0 = cx * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;
  const cells = [];
  const at = (gx, gz) => {
    const i = gx + gz * n;
    if (Number.isNaN(heights[i])) {
      const s = heightAt.sample(x0 + gx * step, z0 + gz * step);
      heights[i] = s.h;
      ids[i] = s.rockZone > 0 ? s.stoneId : -1;
    }
    return i;
  };
  for (let mz = rows[0]; mz < rows[1]; mz++) {
    for (let mx = 0; mx < CHUNK_SIZE; mx++) {
      // The metre cell is in if its centre is within the sheet's reach (plus the cell's half-diagonal).
      if (heightAt.roadDistance(x0 + mx + 0.5, z0 + mz + 0.5) > ROCK_REACH + 0.75) continue;
      for (let j = 0; j < per; j++) {
        for (let i = 0; i < per; i++) {
          const gx = mx * per + i;
          const gz = mz * per + j;
          at(gx, gz);
          at(gx + 1, gz);
          at(gx, gz + 1);
          at(gx + 1, gz + 1);
          cells.push(gx + gz * n);
        }
      }
    }
  }
  return { heights, ids, cells, n, x0, z0 };
}

// Linear-light colours from sRGB hex (what three's Color does), for the vertex colours.
const lin = (hex) => [0, 2, 4].map((k) => {
  const c = parseInt(hex.slice(1 + k, 3 + k), 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const LIGHT = lin('#d9c294');
const DARK = lin('#9a8260');
const GREY = lin('#a39d90');
const OCHRE = lin('#c08a4e');
// The big slabs: paler, weathered sandstone.
const SLAB_LIGHT = lin('#e2d2ac');
const SLAB_DARK = lin('#b9a47c');
const tone = { r: 0, g: 0, b: 0 };
const mix = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);

// `id`: the boulder layer (whole part: 0 small, 1 boulders, 2 slabs) plus a per-boulder random.
function toneFor(id, out) {
  if (id >= 2) {
    const c = mix(mix(SLAB_DARK, SLAB_LIGHT, (id * 3.7) % 1), OCHRE, Math.max(0, ((id * 13.1) % 1) - 0.75));
    [out.r, out.g, out.b] = c;
    return out;
  }
  let c = mix(DARK, LIGHT, (id * 3.7) % 1);
  c = mix(c, GREY, ((id * 7.3) % 1) * 0.5);
  c = mix(c, OCHRE, Math.max(0, ((id * 13.1) % 1) - 0.6));
  [out.r, out.g, out.b] = c;
  return out;
}

// Vertex data for the drawn sheet (plain arrays, so the chunk worker can build it), or null if the
// chunk has none. Triangles are split along the same diagonal as the ground mesh.
export function rockSheetData(heightAt, cx, cz) {
  if (!heightAt.rockAt) return null;
  const step = ROCK_SHEET_STEP;
  const { heights, ids, cells, n, x0, z0 } = sampleSheet(heightAt, cx, cz, step);
  if (!cells.length) return null;
  const positions = new Float32Array(cells.length * 18);
  const normals = new Float32Array(cells.length * 18);
  const colors = new Float32Array(cells.length * 18);
  let o = 0;
  const put = (i, nx, ny, nz) => {
    const gx = i % n;
    const gz = (i - gx) / n;
    positions[o] = x0 + gx * step;
    positions[o + 1] = heights[i];
    positions[o + 2] = z0 + gz * step;
    normals[o] = nx;
    normals[o + 1] = ny;
    normals[o + 2] = nz;
    colors[o] = tone.r;
    colors[o + 1] = tone.g;
    colors[o + 2] = tone.b;
    o += 3;
  };
  const tri = (a, b, c) => {
    // Face normal from the three corners.
    const ax = (a % n) * step, az = Math.floor(a / n) * step, ay = heights[a];
    const bx = (b % n) * step, bz = Math.floor(b / n) * step, by = heights[b];
    const cx2 = (c % n) * step, cz2 = Math.floor(c / n) * step, cy = heights[c];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const wx = cx2 - ax, wy = cy - ay, wz = cz2 - az;
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    // The facet's colour: its boulder's tone (the corner ids agree inside a boulder's facets),
    // bare ground colour where the sheet has faded out.
    const id = Math.max(ids[a], ids[b], ids[c]);
    toneFor(id < 0 ? 0.5 : id, tone);
    put(a, nx / len, ny / len, nz / len);
    put(b, nx / len, ny / len, nz / len);
    put(c, nx / len, ny / len, nz / len);
  };
  for (const a of cells) {
    const b = a + 1;
    const c = a + n;
    const d = c + 1;
    tri(a, c, b);
    tri(b, c, d);
  }
  return { positions, normals, colors };
}

// Bands a chunk's sheet collider is built in, one per call (each a few ms).
export const ROCK_COLLIDER_BANDS = 4;

// One band of the sheet as an indexed triangle mesh on a 50 cm grid, for a Rapier trimesh collider
// (the car body and rims; the GPU tyres read the height function itself), or null.
export function rockSheetTrimesh(heightAt, cx, cz, band = 0) {
  if (!heightAt.rockAt) return null;
  const step = ROCK_COLLIDER_STEP;
  const rows = CHUNK_SIZE / ROCK_COLLIDER_BANDS;
  const { heights, cells, n, x0, z0 } = sampleSheet(heightAt, cx, cz, step, [band * rows, (band + 1) * rows]);
  if (!cells.length) return null;
  const index = new Map();
  const verts = [];
  const vert = (i) => {
    let k = index.get(i);
    if (k === undefined) {
      k = verts.length / 3;
      index.set(i, k);
      const gx = i % n;
      verts.push(x0 + gx * step, heights[i], z0 + ((i - gx) / n) * step);
    }
    return k;
  };
  const indices = new Uint32Array(cells.length * 6);
  let o = 0;
  for (const a of cells) {
    const b = a + 1;
    const c = a + n;
    const d = c + 1;
    indices[o++] = vert(a);
    indices[o++] = vert(c);
    indices[o++] = vert(b);
    indices[o++] = vert(b);
    indices[o++] = vert(c);
    indices[o++] = vert(d);
  }
  return { vertices: new Float32Array(verts), indices };
}
