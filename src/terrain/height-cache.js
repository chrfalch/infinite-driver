// The ground's height for things that ask many times a frame near the same spots (the soil and
// dust thrown by the tyres): heightAt at the corners of a 12.5 cm grid, each worked out the first
// time it is asked for and kept, and blended between them. The procedural heightAt costs 0.4-2.4 µs
// a call, and thousands of grains in flight asked for it every frame.
//
// The kept corners live in a square of (2^bits)² slots that wraps around the world (64 m a side
// by default), each slot tagged with the corner it holds, so it fills in wherever the cars go and
// a corner from 64 m away is simply worked out again.
import { DEFORM_CELL } from './deformation.js';

const EMPTY = -0x80000000;

export function createHeightCache(heightAt, { cell = DEFORM_CELL, bits = 9 } = {}) {
  const size = 1 << bits;
  const mask = size - 1;
  const tagX = new Int32Array(size * size).fill(EMPTY);
  const tagZ = new Int32Array(size * size);
  const heights = new Float32Array(size * size);
  const corner = (ix, iz) => {
    const k = ((iz & mask) << bits) | (ix & mask);
    if (tagX[k] !== ix || tagZ[k] !== iz) {
      tagX[k] = ix;
      tagZ[k] = iz;
      heights[k] = heightAt(ix * cell, iz * cell);
    }
    return heights[k];
  };
  return (x, z) => {
    const gx = x / cell;
    const gz = z / cell;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const a = corner(ix, iz);
    const b = corner(ix + 1, iz);
    const c = corner(ix, iz + 1);
    const d = corner(ix + 1, iz + 1);
    return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
  };
}
