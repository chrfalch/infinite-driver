// Local flat projection around a place on Earth, in Web Mercator (the projection map tiles use).
// World axes: +x east, +z south, y up, metres. The origin (0, 0) is the place itself.
//
// Mercator stretches distances by 1 / cos(latitude); the stretch is taken at the origin, so a
// metre in the game is a metre on the ground there (off by about 0.1 % per 4 km north or south
// at Oslo's latitude, which nobody will notice while driving).
const EARTH_CIRCUMFERENCE = 40075016.686; // m at the equator
export const TILE_SIZE = 256; // px

// Global pixel coordinates of a latitude/longitude at a zoom level (tile = floor(px / 256)).
export function lonLatToPixel(lon, lat, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const s = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
  };
}

export function pixelToLonLat(x, y, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  return { lon: (x / scale) * 360 - 180, lat: (180 / Math.PI) * Math.atan(Math.sinh(n)) };
}

export function createProjection({ lat, lon }) {
  // Ground metres per pixel at zoom 0 at the origin's latitude.
  const metresPerPixel0 = (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / TILE_SIZE;
  const origin0 = lonLatToPixel(lon, lat, 0);
  return {
    lat,
    lon,
    metresPerPixel: (zoom) => metresPerPixel0 / 2 ** zoom,
    // World metres to global pixel coordinates at a zoom level.
    toPixel(x, z, zoom) {
      const k = 2 ** zoom;
      return { x: (origin0.x + x / metresPerPixel0) * k, y: (origin0.y + z / metresPerPixel0) * k };
    },
    fromPixel(px, py, zoom) {
      const k = 2 ** zoom;
      return { x: (px / k - origin0.x) * metresPerPixel0, z: (py / k - origin0.y) * metresPerPixel0 };
    },
    toLonLat(x, z) {
      return pixelToLonLat(origin0.x + x / metresPerPixel0, origin0.y + z / metresPerPixel0, 0);
    },
    fromLonLat(lon, lat) {
      const p = lonLatToPixel(lon, lat, 0);
      return { x: (p.x - origin0.x) * metresPerPixel0, z: (p.y - origin0.y) * metresPerPixel0 };
    },
  };
}
