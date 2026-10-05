// The ground as it is drawn: the 1 m ground mesh (terrain/chunk.js) and, on the dry river, the
// 25 cm rock sheet on top (terrain/rock-sheet.js), each on the same triangles as its mesh (the
// sheet's grid points are jittered, and so are its triangles here). The GPU
// tyres feel this surface, so they sit on what you see. The height function itself curves between
// the mesh's vertices, and in hollows the flat triangles lie above it (up to about 4 cm on the
// canyon and 12 cm on the rock sheet), where the tyre sank into the drawn ground.
import { CHUNK_SIZE, CHUNK_RES } from './chunk.js';
import { ROCK_SHEET_JITTER, ROCK_SHEET_STEP, jitteredPoint } from './rock-sheet.js';
import { ROCK_REACH } from './riverbed.js';

const GROUND_STEP = CHUNK_SIZE / CHUNK_RES;
const MAX_CACHED = 200000; // corner heights kept before the cache starts over

// Height on a square grid of `step` from corner heights f(ix, iz), split along the same diagonal
// as the meshes (a, c, b) and (b, c, d).
function onTriangles(f, step, x, z) {
  const gx = x / step;
  const gz = z / step;
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const fx = gx - ix;
  const fz = gz - iz;
  if (fx + fz <= 1) {
    const h00 = f(ix, iz);
    return h00 + (f(ix + 1, iz) - h00) * fx + (f(ix, iz + 1) - h00) * fz;
  }
  const h11 = f(ix + 1, iz + 1);
  return h11 + (f(ix, iz + 1) - h11) * (1 - fx) + (f(ix + 1, iz) - h11) * (1 - fz);
}

// Height on a jittered grid (as rock-sheet.js draws the sheet): grid point (ix, iz) moved to
// p(ix, iz) = { x, z }, with height f(ix, iz), and the cells split along the same diagonal. The
// jitter is under half a step each way, so the triangles over (x, z) belong to its plain cell or a
// neighbour. Where the jitter folds a thin triangle over its neighbour, the higher one is what you
// see, so this is the highest. Only cells that are drawn (`drawn(cx, cz)`) count; NaN if none.
function onJitteredTriangles(f, p, step, x, z, drawn) {
  const ix = Math.floor(x / step);
  const iz = Math.floor(z / step);
  // The 4 x 4 grid points around the cell, then the 3 x 3 cells between them.
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const k = j * 4 + i;
      NEAR_P[k] = p(ix - 1 + i, iz - 1 + j);
      NEAR_H[k] = f(ix - 1 + i, iz - 1 + j);
    }
  }
  let top = NaN;
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const k = j * 4 + i;
      const a = NEAR_P[k];
      const b = NEAR_P[k + 1];
      const c = NEAR_P[k + 4];
      const d = NEAR_P[k + 5];
      // Quick reject: the cell's bounding box.
      if (x < Math.min(a.x, b.x, c.x, d.x) - EDGE || x > Math.max(a.x, b.x, c.x, d.x) + EDGE) continue;
      if (z < Math.min(a.z, b.z, c.z, d.z) - EDGE || z > Math.max(a.z, b.z, c.z, d.z) + EDGE) continue;
      if (!drawn(ix - 1 + i, iz - 1 + j)) continue;
      const lower = inTriangle(a, c, b, x, z, NEAR_H[k], NEAR_H[k + 4], NEAR_H[k + 1]);
      const upper = inTriangle(b, c, d, x, z, NEAR_H[k + 1], NEAR_H[k + 4], NEAR_H[k + 5]);
      if (!Number.isNaN(lower) && !(lower <= top)) top = lower;
      if (!Number.isNaN(upper) && !(upper <= top)) top = upper;
    }
  }
  return top;
}
const NEAR_P = new Array(16);
const NEAR_H = new Float64Array(16);
const EDGE = 1e-9; // barycentric slack, so points on a shared edge are found

// Height at (x, z) on the triangle (p, q, r) with heights (hp, hq, hr), or NaN if it is outside.
function inTriangle(p, q, r, x, z, hp, hq, hr) {
  const det = (q.z - r.z) * (p.x - r.x) + (r.x - q.x) * (p.z - r.z);
  const u = ((q.z - r.z) * (x - r.x) + (r.x - q.x) * (z - r.z)) / det;
  const v = ((r.z - p.z) * (x - r.x) + (p.x - r.x) * (z - r.z)) / det;
  const w = 1 - u - v;
  if (u < -EDGE || v < -EDGE || w < -EDGE) return NaN;
  return u * hp + v * hq + w * hr;
}

// On snow the ground near the car is drawn on the tyres' own 12.5 cm grid (render/snow-surface.js),
// so there the drawn surface is the height function itself; `coarse` asks for the 1 m mesh anyway.
export function drawnSurface(heightAt, coarse = false) {
  if (heightAt.snowAt && !coarse) return heightAt;
  const ground = heightAt.coarse ?? heightAt;
  const sheet = heightAt.coarse && heightAt.sample ? (x, z) => heightAt.sample(x, z).h : null;
  const cache = new Map();
  const corner = (fn, step, tag) => (ix, iz) => {
    const key = `${tag}${ix},${iz}`;
    let h = cache.get(key);
    if (h === undefined) {
      if (cache.size > MAX_CACHED) cache.clear();
      h = fn(ix * step, iz * step);
      cache.set(key, h);
    }
    return h;
  };
  const groundCorner = corner(ground, GROUND_STEP, 'g');
  // The sheet's grid points where its mesh puts them, with their heights.
  const points = new Map();
  const sheetPoint = (ix, iz) => {
    const key = ix * 1048576 + iz;
    let q = points.get(key);
    if (!q) {
      if (points.size > MAX_CACHED) points.clear();
      q = jitteredPoint(ix, iz, ROCK_SHEET_STEP, ROCK_SHEET_JITTER, { x: 0, z: 0, h: 0 });
      q.h = sheet(q.x, q.z);
      points.set(key, q);
    }
    return q;
  };
  const sheetHeight = (ix, iz) => sheetPoint(ix, iz).h;
  // Whether the sheet's grid cell (ix, iz) is drawn: its metre cell is within reach.
  const per = Math.round(1 / ROCK_SHEET_STEP);
  const covered = new Map();
  const sheetCell = (ix, iz) => {
    const mx = Math.floor(ix / per);
    const mz = Math.floor(iz / per);
    const key = mx * 1048576 + mz;
    let c = covered.get(key);
    if (c === undefined) {
      if (covered.size > MAX_CACHED) covered.clear();
      c = heightAt.roadDistance(mx + 0.5, mz + 0.5) <= ROCK_REACH + 0.75;
      covered.set(key, c);
    }
    return c;
  };
  // Metre cells the sheet's triangles may reach into: a covered cell or a neighbour of one.
  const nearSheet = (mx, mz) => {
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (sheetCell((mx + i) * per, (mz + j) * per)) return true;
    return false;
  };
  return (x, z) => {
    const h = onTriangles(groundCorner, GROUND_STEP, x, z);
    // The sheet covers the metre cells whose centre is within its reach (as rock-sheet.js samples
    // it) and is drawn over the ground there. Its jittered triangles reach a little past those
    // cells' edges, so look a metre around.
    if (!sheet || !nearSheet(Math.floor(x), Math.floor(z))) return h;
    const top = onJitteredTriangles(sheetHeight, sheetPoint, ROCK_SHEET_STEP, x, z, sheetCell);
    return Number.isNaN(top) ? h : Math.max(h, top);
  };
}
