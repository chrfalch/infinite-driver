// Real-world terrain from elevation tiles around a place (see geo/place.js).
//
// Heights come from Terrarium tiles at zoom 14 (about 4.8 m per pixel at Oslo's latitude; the
// Norwegian source data is a 10 m DEM). Between pixels the height is a Catmull-Rom (bicubic)
// blend, so slopes are smooth for the tyres instead of creased like a bilinear blend.
//
// heightAt stays synchronous, like the generated terrains: tiles are downloaded ahead with
// heightAt.ensure / heightAt.load, and the terrain streaming waits for a chunk's tiles before it
// builds the chunk. A height asked for outside the loaded tiles is 0 (sea level).
import { createProjection, TILE_SIZE } from '../geo/projection.js';
import { bitmapPixels, decodeTerrarium, ELEVATION_URL, loadTileBitmap } from '../geo/tiles.js';

export const ELEVATION_ZOOM = 14;
// Terrarium has sea-floor depths; the fjord is kept shallow so a car that drives in can get out.
export const SEA_FLOOR = -2.5;

// Catmull-Rom weights for the four samples around t in [0, 1).
function weights(t, out) {
  const t2 = t * t;
  const t3 = t2 * t;
  out[0] = 0.5 * (-t3 + 2 * t2 - t);
  out[1] = 0.5 * (3 * t3 - 5 * t2 + 2);
  out[2] = 0.5 * (-3 * t3 + 4 * t2 + t);
  out[3] = 0.5 * (t3 - t2);
  return out;
}

// Height field over a grid of tiles given by tileHeights(tx, ty) -> Float32Array(256 * 256) or
// null; pixelAt(x, z) maps world metres to global pixel coordinates. Pure, so it can be tested.
export function createTileSampler(tileHeights, pixelAt) {
  const wx = new Float64Array(4);
  const wz = new Float64Array(4);
  // The last tile looked up (most samples in a row fall in the same one). Missing tiles are not
  // kept, so a tile that loads later is picked up.
  let lastTile = null;
  let lastTx = 0;
  let lastTy = 0;

  function pixel(px, py) {
    const tx = Math.floor(px / TILE_SIZE);
    const ty = Math.floor(py / TILE_SIZE);
    if (!lastTile || tx !== lastTx || ty !== lastTy) {
      lastTx = tx;
      lastTy = ty;
      lastTile = tileHeights(tx, ty);
    }
    if (!lastTile) return 0;
    const h = lastTile[px - tx * TILE_SIZE + (py - ty * TILE_SIZE) * TILE_SIZE];
    return h < SEA_FLOOR ? SEA_FLOOR : h;
  }

  return function sample(x, z) {
    const p = pixelAt(x, z);
    // Pixel values sit at pixel centres.
    const u = p.x - 0.5;
    const v = p.y - 0.5;
    const iu = Math.floor(u);
    const iv = Math.floor(v);
    weights(u - iu, wx);
    weights(v - iv, wz);
    let h = 0;
    for (let j = 0; j < 4; j++) {
      let row = 0;
      for (let i = 0; i < 4; i++) row += wx[i] * pixel(iu - 1 + i, iv - 1 + j);
      h += wz[j] * row;
    }
    return h;
  };
}

// Real terrain around `place` ({ lat, lon }). Heights are relative to sea level.
export function createRealHeightField(place) {
  const projection = createProjection(place);
  const zoom = ELEVATION_ZOOM;
  const tiles = new Map(); // "tx,ty" -> Float32Array, or null for a missing tile
  const pending = new Map(); // "tx,ty" -> Promise

  function request(tx, ty) {
    const key = `${tx},${ty}`;
    if (tiles.has(key)) return null;
    let promise = pending.get(key);
    if (!promise) {
      promise = loadTileBitmap(ELEVATION_URL(zoom, tx, ty)).then((bitmap) => {
        tiles.set(key, bitmap ? decodeTerrarium(bitmapPixels(bitmap), TILE_SIZE * TILE_SIZE) : null);
        pending.delete(key);
      });
      pending.set(key, promise);
    }
    return promise;
  }

  // Tiles under a world rectangle, with a margin for the bicubic samples and the normals.
  function tileRange(x0, z0, x1, z1) {
    const margin = 3 * projection.metresPerPixel(zoom);
    const a = projection.toPixel(x0 - margin, z0 - margin, zoom);
    const b = projection.toPixel(x1 + margin, z1 + margin, zoom);
    return [Math.floor(a.x / TILE_SIZE), Math.floor(a.y / TILE_SIZE), Math.floor(b.x / TILE_SIZE), Math.floor(b.y / TILE_SIZE)];
  }

  const heightAt = createTileSampler(
    (tx, ty) => tiles.get(`${tx},${ty}`) ?? null,
    (x, z) => projection.toPixel(x, z, zoom),
  );

  // True when every tile under the rectangle is loaded; starts downloads for the others.
  heightAt.ensure = (x0, z0, x1, z1) => {
    const [ta, tb, tc, td] = tileRange(x0, z0, x1, z1);
    let ready = true;
    for (let ty = tb; ty <= td; ty++) for (let tx = ta; tx <= tc; tx++) if (request(tx, ty)) ready = false;
    return ready;
  };
  // Resolves when every tile under the rectangle is loaded.
  heightAt.load = async (x0, z0, x1, z1) => {
    const [ta, tb, tc, td] = tileRange(x0, z0, x1, z1);
    const jobs = [];
    for (let ty = tb; ty <= td; ty++) for (let tx = ta; tx <= tc; tx++) jobs.push(request(tx, ty));
    await Promise.all(jobs);
  };
  heightAt.real = { place, projection };
  return heightAt;
}
