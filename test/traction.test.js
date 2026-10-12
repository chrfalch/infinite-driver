import { describe, expect, it } from 'vitest';
import { DEFAULT_GPU_TIRE, DEFAULT_GROUND, DEFAULT_TIRE, SURFACE_GRIP, dirtGrip, effectiveGpuTire } from '../src/tire/config.js';
import { treadParticleArea } from '../src/tire/gpu-tire-solver.js';
import { gpuTireMeshes, referenceTreadArea } from '../src/tire/gpu-tires.js';
import { createCanyonField } from '../src/terrain/canyon.js';
import { DEFAULT_DRIVETRAIN, lockStage, setLockStage } from '../src/vehicle/drivetrain.js';
import { slipTint } from '../src/ui/gauges.js';

describe('surface grip', () => {
  it('grips about μ 0.8 on packed dirt, less on loose soil and gravel, about 1.1 on rock', () => {
    const mu = (ground) => DEFAULT_GPU_TIRE.friction * dirtGrip(ground);
    expect(mu({ softness: 0, gravel: 0 })).toBeCloseTo(0.825, 2);
    expect(mu({ softness: 0.6, gravel: 0 })).toBeLessThan(0.7);
    expect(mu({ softness: 0, gravel: 1 })).toBeLessThan(0.65);
    const s = effectiveGpuTire(DEFAULT_GPU_TIRE, false, DEFAULT_GROUND, null);
    // Loose soil off the road about 0.55, the graded road about 0.8, sandstone 1.1.
    expect(s.friction).toBeGreaterThan(0.5);
    expect(s.friction).toBeLessThan(0.62);
    expect(s.roadFriction).toBeGreaterThan(0.75);
    expect(s.roadFriction).toBeLessThan(0.85);
    expect(s.rockFriction).toBeCloseTo(1.1, 2);
  });

  it('locks up on the road at about μ 0.7 and on loose soil well below it', () => {
    const s = effectiveGpuTire(DEFAULT_GPU_TIRE, false, DEFAULT_GROUND, null);
    expect(s.roadFriction * s.roadSlideGrip).toBeGreaterThan(0.65);
    expect(s.roadFriction * s.roadSlideGrip).toBeLessThan(0.75);
    expect(s.friction * s.slideGrip).toBeLessThan(0.5);
  });

  it('gives loose soil cohesion and plough, none on hard ground', () => {
    const soft = effectiveGpuTire(DEFAULT_GPU_TIRE, false, DEFAULT_GROUND, null);
    expect(soft.cohesion).toBeGreaterThan(0);
    expect(soft.plough).toBeGreaterThan(0);
    const hard = effectiveGpuTire(DEFAULT_GPU_TIRE, false, { ...DEFAULT_GROUND, softness: 0 }, null);
    expect(hard.cohesion).toBe(0);
    expect(hard.plough).toBe(0);
  });

  it('slides with less grip than it held, on dirt more than on rock', () => {
    const s = effectiveGpuTire(DEFAULT_GPU_TIRE, false, DEFAULT_GROUND, null);
    expect(s.slideGrip).toBe(SURFACE_GRIP.slideGrip);
    expect(s.slideGrip).toBeLessThan(s.rockSlideGrip);
    expect(s.rockSlideGrip).toBeLessThan(1);
    expect(s.slideSpeed).toBeGreaterThan(0);
  });
});

describe('canyon ground', () => {
  it('is road on the centre line, loose soil beside it, rock up on the formations', () => {
    const h = createCanyonField(1337);
    const yaw = h.roadHeading(0, 0);
    const at = (side) => h.groundAt(Math.sin(yaw) * side, Math.cos(yaw) * side);
    expect(at(0).road).toBe(1);
    expect(at(0).rock).toBe(0);
    expect(at(7).road).toBe(0);
    // Somewhere out among the mesas the ground is bare rock.
    let rock = 0;
    for (let d = 40; d < 140 && rock < 1; d += 2) rock = Math.max(rock, at(d).rock);
    expect(rock).toBeGreaterThan(0.9);
  });
});

describe('tyre size on soil', () => {
  it('measures the tread area per particle, which grows with a wider or taller tyre', () => {
    const area = (tire, gpu = DEFAULT_GPU_TIRE) => {
      const { mesh } = gpuTireMeshes({ ...DEFAULT_TIRE, ...tire }, gpu);
      return treadParticleArea(mesh.vertices, mesh.nu, mesh.nv);
    };
    const base = area({});
    expect(base).toBeCloseTo(referenceTreadArea(), 8);
    // About (2π·0.46 / 40) around by a few cm across.
    expect(base).toBeGreaterThan(0.002);
    expect(base).toBeLessThan(0.01);
    expect(area({ width: 0.45 })).toBeGreaterThan(base * 1.2);
    expect(area({ outerRadius: 0.55 })).toBeGreaterThan(base * 1.1);
    // A coarser mesh has fewer, bigger particles (the soil springs scale with it).
    expect(area({}, { ...DEFAULT_GPU_TIRE, segmentsAround: 32, segmentsAcross: 8 })).toBeGreaterThan(base);
  });
});

describe('differential lock switch', () => {
  it('steps open, centre, centre + rear, all three, and back to open', () => {
    const p = { ...DEFAULT_DRIVETRAIN };
    const seen = [];
    for (let i = 0; i < 5; i++) {
      seen.push([lockStage(p), p.centerLock, p.rearLock, p.frontLock]);
      setLockStage(p, lockStage(p) + 1);
    }
    expect(seen).toEqual([
      [0, false, false, false],
      [1, true, false, false],
      [2, true, true, false],
      [3, true, true, true],
      [0, false, false, false],
    ]);
  });

  it('a lone front lock (from the panel) counts as the last stage, so the next press opens all', () => {
    const p = { ...DEFAULT_DRIVETRAIN, frontLock: true };
    setLockStage(p, lockStage(p) + 1);
    expect([p.centerLock, p.rearLock, p.frontLock]).toEqual([false, false, false]);
  });
});

describe('drive plate wheel tint', () => {
  it('goes from cream when rolling to amber when slipping to red when spinning, either way', () => {
    const rolling = slipTint(0);
    const slipping = slipTint(0.6);
    const spinning = slipTint(4);
    expect(rolling.b).toBeGreaterThan(slipping.b);
    expect(spinning.g).toBeLessThan(slipping.g);
    expect(slipTint(-4)).toEqual(spinning);
  });
});
