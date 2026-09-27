// Small TSL noise helpers shared by the city materials.
import { dot, floor, fract, mix, sin, vec2 } from 'three/tsl';

// Random number in [0, 1) per 2D point (use with floored cells).
export const hash2 = (p) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));

// Smooth value noise in [0, 1): random values on the integer grid, blended with a smoothstep.
export const valueNoise = (p) => {
  const i = floor(p);
  const f = fract(p);
  const w = f.mul(f).mul(f.mul(-2).add(3));
  const a = hash2(i);
  const b = hash2(i.add(vec2(1, 0)));
  const c = hash2(i.add(vec2(0, 1)));
  const d = hash2(i.add(vec2(1, 1)));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
};
