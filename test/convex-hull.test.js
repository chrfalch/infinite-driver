import { createNoise3D } from 'simplex-noise';
import { describe, expect, it } from 'vitest';
import { convexHull } from '../src/terrain/convex-hull.js';
import { mulberry32 } from '../src/terrain/height.js';
import { makeRock } from '../src/terrain/rocks.js';
import { rockToGpu, ROCK_FACES } from '../src/tire/gpu-tire-solver.js';

describe('convex hull', () => {
  it('encloses every point of noisy rocks with outward faces', () => {
    const rand = mulberry32(11);
    const noise = createNoise3D(rand);
    for (let r = 0; r < 20; r++) {
      const rock = makeRock(() => 0, r, 0, 0.3 + rand(), rand, noise);
      const faces = convexHull(rock.vertices);
      expect(faces.length).toBeGreaterThan(8);
      const v = rock.vertices;
      for (const [a, b, c] of faces) {
        const A = [v[a * 3], v[a * 3 + 1], v[a * 3 + 2]];
        const u = [v[b * 3] - A[0], v[b * 3 + 1] - A[1], v[b * 3 + 2] - A[2]];
        const w = [v[c * 3] - A[0], v[c * 3 + 1] - A[1], v[c * 3 + 2] - A[2]];
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const len = Math.hypot(...n);
        for (let i = 0; i < v.length; i += 3) {
          const d = (n[0] * (v[i] - A[0]) + n[1] * (v[i + 1] - A[1]) + n[2] * (v[i + 2] - A[2])) / len;
          expect(d).toBeLessThan(1e-4);
        }
      }
    }
  });

  it('gives the GPU the same solid as the physics (all vertices inside its planes)', () => {
    const rand = mulberry32(5);
    const noise = createNoise3D(rand);
    const rock = makeRock(() => 0, 0, 0, 0.8, rand, noise);
    const { planes } = rockToGpu(rock);
    const v = rock.vertices;
    for (let i = 0; i < v.length; i += 3) {
      let worst = -1e9;
      for (let f = 0; f < ROCK_FACES; f++) {
        const [nx, ny, nz, d] = planes.subarray(f * 4, f * 4 + 4);
        if (nx === 0 && ny === 0 && nz === 0) continue;
        worst = Math.max(worst, nx * v[i] + ny * v[i + 1] + nz * v[i + 2] - d);
      }
      expect(worst).toBeLessThan(1e-4);
    }
  });
});
