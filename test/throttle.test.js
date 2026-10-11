import { describe, expect, it } from 'vitest';
import { updateThrottle } from '../src/systems/input.js';

const run = (state, frames, input) => {
  for (let i = 0; i < frames; i++) updateThrottle(state, { pedal: false, lockTap: false, release: false, dt: 0.1, ramp: 0.8, ...input });
  return state;
};

describe('throttle', () => {
  it('opens over the ramp time while held and closes quickly when let go', () => {
    const s = { throttle: 0, lock: null };
    run(s, 4, { pedal: true });
    expect(s.throttle).toBeCloseTo(0.5);
    run(s, 4, { pedal: true });
    expect(s.throttle).toBe(1);
    run(s, 2, {});
    expect(s.throttle).toBe(0);
  });

  it('opens at once with no ramp', () => {
    expect(run({ throttle: 0, lock: null }, 1, { pedal: true, ramp: 0 }).throttle).toBe(1);
  });

  it('Shift locks it where it is; the pedal opens it further and it falls back to the lock', () => {
    const s = { throttle: 0, lock: null };
    run(s, 3, { pedal: true });
    updateThrottle(s, { pedal: true, lockTap: true, release: false, dt: 0.1, ramp: 0.8 });
    expect(s.lock).toBeCloseTo(0.375);
    run(s, 10, {});
    expect(s.throttle).toBeCloseTo(0.375);
    run(s, 2, { pedal: true });
    expect(s.throttle).toBeCloseTo(0.625);
    run(s, 5, {});
    expect(s.throttle).toBeCloseTo(0.375);
  });

  it('Shift again, or the brake, lets it go', () => {
    const s = { throttle: 0.4, lock: 0.4 };
    updateThrottle(s, { pedal: false, lockTap: true, release: false, dt: 0.1, ramp: 0.8 });
    expect(s.lock).toBe(null);
    const t = { throttle: 0.4, lock: 0.4 };
    run(t, 3, { release: true });
    expect(t.lock).toBe(null);
    expect(t.throttle).toBe(0);
  });

  it('Shift with the throttle shut locks nothing', () => {
    const s = { throttle: 0, lock: null };
    updateThrottle(s, { pedal: false, lockTap: true, release: false, dt: 0.1, ramp: 0.8 });
    expect(s.lock).toBe(null);
  });
});
