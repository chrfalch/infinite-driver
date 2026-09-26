import { createNoise2D } from 'simplex-noise';
import { createCanyonField } from './canyon.js';

// Small seeded PRNG so the world is the same on every load.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createHeightField({ seed = 1337, mode = 'flat' } = {}) {
  if (mode === 'flat') return () => 0;
  if (mode === 'canyon') return createCanyonField(seed);

  const rand = mulberry32(seed);
  const continents = createNoise2D(rand);
  const hills = createNoise2D(rand);
  const bumps = createNoise2D(rand);
  const ripples = createNoise2D(rand);

  return function heightAt(x, z) {
    // Broad regions decide whether we are on flats or in hilly country.
    const region = continents(x * 0.0022, z * 0.0022) * 0.5 + 0.5;
    const hilliness = region * region;

    let h = 0;
    h += continents(x * 0.004, z * 0.004) * 14;
    h += hills(x * 0.014, z * 0.014) * 7 * (0.25 + hilliness);
    h += bumps(x * 0.06, z * 0.06) * 0.9 * (0.3 + hilliness);
    h += ripples(x * 0.25, z * 0.25) * 0.06;
    return h;
  };
}
