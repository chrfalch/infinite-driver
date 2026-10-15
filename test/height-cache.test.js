import { describe, expect, it } from 'vitest';
import { createHeightCache } from '../src/terrain/height-cache.js';

describe('height cache', () => {
  it('matches a plane exactly and a smooth surface closely', () => {
    const plane = (x, z) => 0.3 * x - 0.2 * z + 5;
    const flat = createHeightCache(plane);
    const wavy = (x, z) => Math.sin(x * 0.7) * 2 + Math.cos(z * 0.4);
    const cached = createHeightCache(wavy);
    for (let i = 0; i < 500; i++) {
      const x = (Math.random() - 0.5) * 200;
      const z = (Math.random() - 0.5) * 200;
      expect(flat(x, z)).toBeCloseTo(plane(x, z), 4);
      // Bilinear over 12.5 cm: the error is about curvature * cell² / 8.
      expect(Math.abs(cached(x, z) - wavy(x, z))).toBeLessThan(0.003);
    }
  });

  it('asks for each corner once while it stays in the cache', () => {
    let calls = 0;
    const cache = createHeightCache((x, z) => (calls++, x + z));
    for (let i = 0; i < 1000; i++) cache(1 + (i % 10) * 0.01, 2 + Math.floor(i / 100) * 0.01);
    expect(calls).toBe(4);
  });

  it('works out a corner again when a far one took its slot', () => {
    const cache = createHeightCache((x, z) => x * 10 + z, { bits: 2 });
    expect(cache(0, 0)).toBeCloseTo(0);
    // 4 slots of 12.5 cm: 0.5 m away lands in the same slots.
    expect(cache(0.5, 0)).toBeCloseTo(5);
    expect(cache(0, 0)).toBeCloseTo(0);
    expect(cache(-3.7, 1.2)).toBeCloseTo(-37 + 1.2, 4);
  });
});
