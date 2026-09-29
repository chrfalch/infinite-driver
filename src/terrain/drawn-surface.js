// The ground as it is drawn: the 1 m ground mesh (terrain/chunk.js) and, on the dry river, the
// 25 cm rock sheet on top (terrain/rock-sheet.js), each on the same triangles as its mesh. The GPU
// tyres feel this surface, so they sit on what you see. The height function itself curves between
// the mesh's vertices, and in hollows the flat triangles lie above it (up to about 4 cm on the
// canyon and 12 cm on the rock sheet), where the tyre sank into the drawn ground.
import { CHUNK_SIZE, CHUNK_RES } from './chunk.js';
import { ROCK_SHEET_STEP } from './rock-sheet.js';
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
  const sheetCorner = sheet && corner(sheet, ROCK_SHEET_STEP, 's');
  return (x, z) => {
    const h = onTriangles(groundCorner, GROUND_STEP, x, z);
    // The sheet covers the metre cells whose centre is within its reach (as rock-sheet.js samples
    // it) and is drawn over the ground there.
    if (!sheet || heightAt.roadDistance(Math.floor(x) + 0.5, Math.floor(z) + 0.5) > ROCK_REACH + 0.75) return h;
    return Math.max(h, onTriangles(sheetCorner, ROCK_SHEET_STEP, x, z));
  };
}
