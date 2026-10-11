import { describe, expect, it } from 'vitest';
import { DEFAULT_GPU_TIRE, DEFAULT_GROUND, SURFACE_GRIP, dirtGrip, effectiveGpuTire } from '../src/tire/config.js';
import { DEFAULT_DRIVETRAIN, lockStage, setLockStage } from '../src/vehicle/drivetrain.js';
import { slipTint } from '../src/ui/gauges.js';

describe('surface grip', () => {
  it('grips about μ 0.8 on packed dirt, less on loose soil and gravel, about 1.1 on rock', () => {
    const mu = (ground) => DEFAULT_GPU_TIRE.friction * dirtGrip(ground);
    expect(mu({ softness: 0, gravel: 0 })).toBeCloseTo(0.825, 2);
    expect(mu({ softness: 0.6, gravel: 0 })).toBeLessThan(0.7);
    expect(mu({ softness: 0, gravel: 1 })).toBeLessThan(0.65);
    const s = effectiveGpuTire(DEFAULT_GPU_TIRE, false, DEFAULT_GROUND, null);
    expect(s.friction).toBeGreaterThan(0.6);
    expect(s.friction).toBeLessThan(0.75);
    expect(s.rockFriction).toBeCloseTo(1.1, 2);
  });

  it('slides with less grip than it held, on dirt more than on rock', () => {
    const s = effectiveGpuTire(DEFAULT_GPU_TIRE, false, DEFAULT_GROUND, null);
    expect(s.slideGrip).toBe(SURFACE_GRIP.slideGrip);
    expect(s.slideGrip).toBeLessThan(s.rockSlideGrip);
    expect(s.rockSlideGrip).toBeLessThan(1);
    expect(s.slideSpeed).toBeGreaterThan(0);
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
