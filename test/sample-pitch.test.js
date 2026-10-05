import { describe, expect, it } from 'vitest';
import { flatten, makeLoop, pitchAt, trackPitch } from '../scripts/samples/pitch.mjs';

const SR = 12000;

// An engine-like tone: the firing pulse's harmonics, its pitch sweeping from f0 to f1.
function sweep(f0, f1, seconds) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const f = f0 + ((f1 - f0) * i) / n;
    ph += (2 * Math.PI * f) / SR;
    x[i] = Math.sin(ph) + 0.6 * Math.sin(2 * ph + 0.5) + 0.3 * Math.sin(3 * ph + 1);
  }
  return x;
}

describe('engine recordings into loops', () => {
  it('tracks the pitch of a rev', () => {
    const x = sweep(60, 300, 4);
    const track = trackPitch(x, SR, { minF: 40, maxF: 450 });
    for (const t of [0.5, 2, 3.5]) {
      const want = 60 + (240 * t) / 4;
      expect(Math.abs(pitchAt(track, t) / want - 1)).toBeLessThan(0.02);
    }
  });

  it('holds a stretch of a rev at one pitch', () => {
    const x = sweep(100, 200, 3);
    const track = trackPitch(x, SR, { minF: 40, maxF: 450 });
    const flat = flatten(x, SR, track, 1, 150, 0.8);
    const t2 = trackPitch(flat, SR, { minF: 40, maxF: 450 });
    for (const p of t2) expect(Math.abs(p.f / 150 - 1)).toBeLessThan(0.02);
  });

  it('makes a loop of whole cycles that wraps without a step', () => {
    const x = sweep(120, 120, 1);
    const loop = makeLoop(x, SR, 120, { perCycle: 4, cycles: 6, fade: 0.03 });
    expect(loop.length).toBe(Math.round((6 * 4 * SR) / 120));
    const wrap = Math.abs(loop[0] - loop[loop.length - 1]);
    let step = 0;
    for (let i = 1; i < loop.length; i++) step = Math.max(step, Math.abs(loop[i] - loop[i - 1]));
    expect(wrap).toBeLessThan(step * 1.1);
  });
});
