// Map tile downloads (elevation and satellite imagery), cached per URL.
//
// The page is cross-origin isolated (COEP require-corp, for Glyph), so every tile is fetched in
// CORS mode; both tile servers below send Access-Control-Allow-Origin: *.

// Terrarium elevation tiles (Mapzen / AWS open data). For Norway the source is Kartverket's 10 m
// DEM; elsewhere SRTM, national DEMs, and ocean bathymetry.
export const ELEVATION_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
// Esri World Imagery. Oslo has imagery down to zoom 19 (about 15 cm per pixel).
export const SATELLITE_URL = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

// Recently used tiles, oldest first (a Map keeps insertion order). Neighbouring terrain chunks
// share tiles; old ones are dropped so a long drive does not keep every tile in memory.
const bitmaps = new Map();
const MAX_CACHED = 256;

// ImageBitmap of a tile (raw pixel values: no colour-space conversion or premultiplied alpha,
// which would corrupt elevation data). Resolves to null if the tile is missing.
export function loadTileBitmap(url) {
  let promise = bitmaps.get(url);
  if (promise) {
    bitmaps.delete(url);
    bitmaps.set(url, promise);
  } else {
    promise = fetch(url, { mode: 'cors' })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => (blob ? createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }) : null))
      .catch((error) => {
        console.warn('tile failed', url, error);
        return null;
      });
    bitmaps.set(url, promise);
    if (bitmaps.size > MAX_CACHED) bitmaps.delete(bitmaps.keys().next().value);
  }
  return promise;
}

// RGBA bytes of a bitmap.
export function bitmapPixels(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

// Terrarium encoding: height = R * 256 + G + B / 256 - 32768 (metres).
export function decodeTerrarium(rgba, count = rgba.length / 4) {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
  return out;
}
