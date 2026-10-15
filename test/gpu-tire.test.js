import { describe, expect, it } from 'vitest';
import { DEFAULT_GPU_TIRE, effectiveGpuTire, surfaceGrip } from '../src/tire/config.js';
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

describe('surface grip', () => {
  it('is the GPU tyres\' dry-ground grip: dirt toward the road by its share, rock its own', () => {
    const gpu = effectiveGpuTire(DEFAULT_GPU_TIRE, false, { softness: 0.4, gravel: 0.6 }, null);
    expect(surfaceGrip(gpu, { road: 0, rock: 0 })).toBeCloseTo(gpu.friction);
    expect(surfaceGrip(gpu, { road: 1, rock: 0 })).toBeCloseTo(gpu.roadFriction);
    expect(surfaceGrip(gpu, { road: 0.5, rock: 0 })).toBeCloseTo((gpu.friction + gpu.roadFriction) / 2);
    expect(surfaceGrip(gpu, { road: 0, rock: 1 })).toBeCloseTo(gpu.rockFriction);
    // No ground info: plain dirt.
    expect(surfaceGrip(gpu, null)).toBeCloseTo(gpu.friction);
    // Loose dirt grips well under a rigid wheel's old fixed 1.25.
    expect(gpu.friction).toBeGreaterThan(0.45);
    expect(gpu.friction).toBeLessThan(0.7);
  });

  it('is fresh snow\'s on snow', () => {
    const snow = { freshStiffness: 1, packedStiffness: 1, rebound: 0, freshGrip: 0.3, packedGrip: 0.4, asphaltGrip: 0.9, iceGrip: 0.1, slideGrip: 0.8, maxSink: 0.2 };
    const gpu = effectiveGpuTire(DEFAULT_GPU_TIRE, false, undefined, snow);
    expect(surfaceGrip(gpu, { road: 1, rock: 0 })).toBeCloseTo(DEFAULT_GPU_TIRE.friction * 0.3);
  });
});
