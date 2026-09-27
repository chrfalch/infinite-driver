import { describe, expect, it } from 'vitest';
import { DEFAULT_GPU_TIRE, effectiveGpuTire } from '../src/tire/config.js';
import { MAX_PER_TIRE, MAX_STEPS, ROCK_FACES, rockToGpu } from '../src/tire/gpu-tire-solver.js';
import { mulberry32 } from '../src/terrain/height.js';
import { makeRock } from '../src/terrain/rocks.js';
import { createNoise3D } from 'simplex-noise';

// The solver itself needs WebGPU (checked in the browser); these cover its CPU-side inputs.
describe('GPU tyre inputs', () => {
  it('turns a rock into a bounding sphere and outward face planes', () => {
    const rand = mulberry32(5);
    const rock = makeRock(() => 0, 3, -2, 0.6, rand, createNoise3D(rand));
    const { sphere, planes } = rockToGpu(rock);
    expect(planes.length).toBe(ROCK_FACES * 4);
    const [cx, cy, cz, r] = sphere;
    // The centre is inside every face plane, and every vertex is inside the sphere.
    for (let f = 0; f < ROCK_FACES; f++) {
      const [nx, ny, nz, dd] = planes.subarray(f * 4, f * 4 + 4);
      expect(nx * cx + ny * cy + nz * cz - dd).toBeLessThan(0);
    }
    for (let i = 0; i < rock.vertices.length; i += 3) {
      expect(Math.hypot(rock.vertices[i] - cx, rock.vertices[i + 1] - cy, rock.vertices[i + 2] - cz)).toBeLessThanOrEqual(r + 1e-5);
    }
  });

  it('keeps every tyre within one workgroup, with and without the performance preset', () => {
    for (const s of [DEFAULT_GPU_TIRE, effectiveGpuTire(DEFAULT_GPU_TIRE, true)]) {
      expect(s.segmentsAround * s.segmentsAcross).toBeLessThanOrEqual(MAX_PER_TIRE);
    }
    expect(effectiveGpuTire(DEFAULT_GPU_TIRE, true).substeps).toBeLessThanOrEqual(DEFAULT_GPU_TIRE.substeps);
  });

  it('runs at most MAX_STEPS physics steps per GPU round trip', () => {
    expect(DEFAULT_GPU_TIRE.stepsPerTrip).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_GPU_TIRE.stepsPerTrip).toBeLessThanOrEqual(MAX_STEPS);
  });
});
