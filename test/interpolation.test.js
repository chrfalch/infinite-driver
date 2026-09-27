import { describe, expect, it } from 'vitest';
import { advanceDisplayTime, createPoseHistory, pushPose, samplePose } from '../src/systems/interpolation.js';

const Q = { x: 0, y: 0, z: 0, w: 1 };
const out = () => ({ position: {}, quaternion: {} });

describe('pose history', () => {
  it('interpolates between the poses around a time and clamps outside them', () => {
    const h = createPoseHistory();
    for (let k = 0; k <= 5; k++) pushPose(h, k * 0.01, { x: k, y: 0, z: 0 }, Q);
    const o = out();
    samplePose(h, 0.025, o);
    expect(o.position.x).toBeCloseTo(2.5);
    samplePose(h, 1, o);
    expect(o.position.x).toBe(5);
    samplePose(h, -1, o);
    expect(o.position.x).toBe(0);
  });

  it('interpolates rotation along the shorter arc', () => {
    const h = createPoseHistory();
    const half = Math.SQRT1_2;
    pushPose(h, 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
    // 90 degrees about y, stored with a negative w (the same rotation).
    pushPose(h, 1, { x: 0, y: 0, z: 0 }, { x: 0, y: -half, z: 0, w: -half });
    const o = out();
    samplePose(h, 0.5, o);
    // 45 degrees about y.
    expect(Math.abs(o.quaternion.y)).toBeCloseTo(Math.sin(Math.PI / 8), 3);
    expect(Math.abs(o.quaternion.w)).toBeCloseTo(Math.cos(Math.PI / 8), 3);
  });

  it('starts over after a teleport', () => {
    const h = createPoseHistory();
    pushPose(h, 0, { x: 0, y: 0, z: 0 }, Q);
    pushPose(h, 0.01, { x: 100, y: 0, z: 0 }, Q);
    const o = out();
    samplePose(h, 0.005, o);
    expect(o.position.x).toBe(100);
  });
});

describe('display time', () => {
  it('moves evenly while physics arrives in uneven batches', () => {
    const step = 1 / 120;
    let latest = 0;
    let display = 0;
    const moves = [];
    // 60 Hz frames; physics finishes 1, 2 or 3 steps before each frame (2 on average).
    const pattern = [1, 3, 2, 1, 3, 2, 2, 2];
    for (let f = 0; f < 400; f++) {
      latest += pattern[f % pattern.length] * step;
      const next = advanceDisplayTime(display, latest, 1 / 60, step);
      if (f > 100) moves.push(next - display);
      display = next;
    }
    const spread = Math.max(...moves) - Math.min(...moves);
    // Raw steps per frame vary by 2 steps (16.7 ms); the display time varies far less.
    expect(spread).toBeLessThan(0.3 * step);
    expect(display).toBeLessThanOrEqual(latest);
  });

  it('follows a physics rate slower than real time without running ahead', () => {
    const step = 1 / 120;
    let latest = 0;
    let display = 0;
    for (let f = 0; f < 600; f++) {
      latest += (f % 3 === 0 ? 2 : 1) * step; // ~0.67 x real time
      display = advanceDisplayTime(display, latest, 1 / 60, step);
      expect(display).toBeLessThanOrEqual(latest);
      expect(display).toBeGreaterThanOrEqual(latest - 4 * step);
    }
  });
});
