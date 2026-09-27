import { describe, expect, it } from 'vitest';
import { createProjection, lonLatToPixel, pixelToLonLat, TILE_SIZE } from '../src/geo/projection.js';
import { decodeTerrarium } from '../src/geo/tiles.js';
import { createTileSampler, SEA_FLOOR } from '../src/terrain/real.js';
import { PLACES } from '../src/geo/place.js';

describe('projection', () => {
  const oslo = createProjection(PLACES.oslo);

  it('puts the place at the origin and round-trips', () => {
    const o = oslo.fromLonLat(PLACES.oslo.lon, PLACES.oslo.lat);
    expect(o.x).toBeCloseTo(0, 6);
    expect(o.z).toBeCloseTo(0, 6);
    const { lat, lon } = oslo.toLonLat(1234, -567);
    const back = oslo.fromLonLat(lon, lat);
    expect(back.x).toBeCloseTo(1234, 4);
    expect(back.z).toBeCloseTo(-567, 4);
    const p = lonLatToPixel(10.7, 59.9, 14);
    const q = pixelToLonLat(p.x, p.y, 14);
    expect(q.lon).toBeCloseTo(10.7, 9);
    expect(q.lat).toBeCloseTo(59.9, 9);
  });

  it('is in ground metres: +x east, +z south', () => {
    // 1 km north along the meridian is about 0.008993 degrees of latitude.
    const north = oslo.fromLonLat(PLACES.oslo.lon, PLACES.oslo.lat + 1000 / 111195);
    expect(north.z).toBeCloseTo(-1000, -1);
    expect(Math.abs(north.x)).toBeLessThan(1e-6);
    const east = oslo.fromLonLat(PLACES.oslo.lon + 0.01, PLACES.oslo.lat);
    // 0.01 degrees of longitude at 59.9 degrees north is about 557 m.
    expect(east.x).toBeGreaterThan(550);
    expect(east.x).toBeLessThan(565);
  });

  it('matches known tiles', () => {
    // The Royal Palace is in zoom-14 tile 8680/4765 (x/y).
    const p = oslo.toPixel(0, 0, 14);
    expect(Math.floor(p.x / TILE_SIZE)).toBe(8680);
    expect(Math.floor(p.y / TILE_SIZE)).toBe(4765);
  });
});

describe('terrarium decoding', () => {
  it('decodes heights', () => {
    // 32768 + 12.5 m = 128 * 256 + 12 + 128 / 256
    const h = decodeTerrarium(new Uint8Array([128, 12, 128, 255, 127, 255, 0, 255]));
    expect(h[0]).toBeCloseTo(12.5, 6);
    expect(h[1]).toBeCloseTo(-1, 6);
  });
});

describe('tile sampler', () => {
  // Tiles filled from a function of global pixel coordinates (value at the pixel centre).
  const tilesOf = (fn) => {
    const cache = new Map();
    return (tx, ty) => {
      const key = `${tx},${ty}`;
      if (!cache.has(key)) {
        const t = new Float32Array(TILE_SIZE * TILE_SIZE);
        for (let j = 0; j < TILE_SIZE; j++) {
          for (let i = 0; i < TILE_SIZE; i++) t[i + j * TILE_SIZE] = fn(tx * TILE_SIZE + i + 0.5, ty * TILE_SIZE + j + 0.5);
        }
        cache.set(key, t);
      }
      return cache.get(key);
    };
  };
  const pixelAt = (x, z) => ({ x: 1000 + x / 4, y: 2000 + z / 4 }); // 4 m per pixel

  it('reproduces a sloping plane exactly, across tile borders', () => {
    const plane = (px, py) => 500 + 0.3 * px - 0.2 * py; // above the sea floor clamp
    const sample = createTileSampler(tilesOf(plane), pixelAt);
    // x = 96 m is pixel 1024, the border of tiles 3 and 4.
    for (const [x, z] of [[0, 0], [95.3, 12.7], [96, 5], [96.9, -3.1], [-400.2, 777.7]]) {
      const p = pixelAt(x, z);
      expect(sample(x, z)).toBeCloseTo(plane(p.x, p.y), 3);
    }
  });

  it('is continuous and smooth', () => {
    const hills = (px, py) => 30 * Math.sin(px * 0.05) * Math.cos(py * 0.07);
    const sample = createTileSampler(tilesOf(hills), pixelAt);
    let maxJump = 0;
    for (let x = 80; x < 110; x += 0.1) maxJump = Math.max(maxJump, Math.abs(sample(x + 0.1, 3) - sample(x, 3)));
    // Slope of the field is at most 30 * 0.05 / 4 = 0.375 m/m, so 0.1 m steps change < 0.04 m.
    expect(maxJump).toBeLessThan(0.045);
  });

  it('keeps the sea floor shallow and treats missing tiles as sea level', () => {
    const deep = createTileSampler(tilesOf(() => -40), pixelAt);
    expect(deep(10, 10)).toBeCloseTo(SEA_FLOOR, 5);
    const none = createTileSampler(() => null, pixelAt);
    expect(none(10, 10)).toBe(0);
  });
});
