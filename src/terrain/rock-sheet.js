// The dry river's rock sheet (terrain/riverbed.js) as its own fine mesh over the coarse 1 m ground:
// one connected, flat-shaded surface on a 25 cm grid, covering only the cells near the bed, each
// facet tinted by the boulder on top (render/rock-surface.js draws it). The physics side builds a
// coarser collider from the same grid (rockSheetTrimesh). Plain maths, no renderer, so both
// workers can use it.
import { CHUNK_SIZE } from './chunk.js';
import { ROCK_REACH } from './riverbed.js';

export const ROCK_SHEET_STEP = 0.25; // m, drawn mesh
export const ROCK_COLLIDER_STEP = 0.5; // m, physics collider

// A hash of a world grid point in [0, 1), for jittering it.
function hash(ix, iz, k) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(k, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Samples the sheet on a `step` grid over the chunk, only in the 1 m cells that the sheet reaches.
// Returns the grid heights and ids (NaN where unsampled), where each point was sampled, and the
// list of covered grid cells. `rows`: the metre rows [from, to) of the chunk to cover (a band, so
// the work can be split). `jitter` (share of a step) moves each point a random bit, the same for
// the same world point in every chunk (so the seams stay closed), so the triangles are uneven and
// steep faces do not show the grid as stair steps.
function sampleSheet(heightAt, cx, cz, step, rows = [0, CHUNK_SIZE], jitter = 0) {
  const per = Math.round(1 / step); // grid cells per metre
  const n = CHUNK_SIZE * per + 1;
  const heights = new Float32Array(n * n).fill(NaN);
  const ids = new Float32Array(n * n);
  const px = new Float32Array(n * n);
  const pz = new Float32Array(n * n);
  const x0 = cx * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;
  const cells = [];
  const at = (gx, gz) => {
    const i = gx + gz * n;
    if (Number.isNaN(heights[i])) {
      const wx = cx * CHUNK_SIZE * per + gx;
      const wz = cz * CHUNK_SIZE * per + gz;
      px[i] = x0 + (gx + jitter * (hash(wx, wz, 1) - 0.5)) * step;
      pz[i] = z0 + (gz + jitter * (hash(wx, wz, 2) - 0.5)) * step;
      const s = heightAt.sample(px[i], pz[i]);
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
  return { heights, ids, px, pz, cells, n, x0, z0 };
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
// chunk has none: an indexed mesh, drawn flat-shaded (render/rock-surface.js), so the chipped skin
// of the boulders shows as hard facets. The grid normals (central differences) are kept for
// anything that reads them. Triangles are split along the same diagonal as the ground mesh.
export function rockSheetData(heightAt, cx, cz) {
  if (!heightAt.rockAt) return null;
  const step = ROCK_SHEET_STEP;
  const { heights, ids, px, pz, cells, n } = sampleSheet(heightAt, cx, cz, step, undefined, 0.7);
  if (!cells.length) return null;
  // Grid points in use, numbered in order.
  const index = new Int32Array(n * n).fill(-1);
  let count = 0;
  for (let i = 0; i < heights.length; i++) if (!Number.isNaN(heights[i])) index[i] = count++;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const h = (i, fallback) => (i >= 0 && i < heights.length && !Number.isNaN(heights[i]) ? heights[i] : fallback);
  for (let i = 0; i < heights.length; i++) {
    const k = index[i];
    if (k < 0) continue;
    const gx = i % n;
    const gz = (i - gx) / n;
    const y = heights[i];
    positions.set([px[i], y, pz[i]], k * 3);
    // Slopes from the neighbours either side (one-sided at the edge of the sampled cells).
    const l = gx > 0 ? h(i - 1, NaN) : NaN;
    const r = gx < n - 1 ? h(i + 1, NaN) : NaN;
    const u = h(i - n, NaN);
    const d = h(i + n, NaN);
    const dx = !Number.isNaN(l) && !Number.isNaN(r) ? (r - l) / (2 * step) : !Number.isNaN(r) ? (r - y) / step : !Number.isNaN(l) ? (y - l) / step : 0;
    const dz = !Number.isNaN(u) && !Number.isNaN(d) ? (d - u) / (2 * step) : !Number.isNaN(d) ? (d - y) / step : !Number.isNaN(u) ? (y - u) / step : 0;
    const len = Math.hypot(dx, 1, dz);
    normals.set([-dx / len, 1 / len, -dz / len], k * 3);
    // Each point takes its boulder's tone (bare ground where the sheet has faded out), darkened in
    // the creases between boulders and a little lighter on their ridges, so the boulders read apart.
    toneFor(ids[i] < 0 ? 0.5 : ids[i], tone);
    const around = (Number.isNaN(l) ? y : l) + (Number.isNaN(r) ? y : r) + (Number.isNaN(u) ? y : u) + (Number.isNaN(d) ? y : d) - 4 * y;
    const shade = 1 - Math.min(0.5, Math.max(0, around * 1.4)) + Math.min(0.12, Math.max(0, -around * 0.5));
    colors.set([tone.r * shade, tone.g * shade, tone.b * shade], k * 3);
  }
  const indices = new Uint32Array(cells.length * 6);
  let o = 0;
  for (const a of cells) {
    const b = a + 1;
    const c = a + n;
    const d = c + 1;
    indices[o++] = index[a];
    indices[o++] = index[c];
    indices[o++] = index[b];
    indices[o++] = index[b];
    indices[o++] = index[c];
    indices[o++] = index[d];
  }
  return { positions, normals, colors, indices };
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
