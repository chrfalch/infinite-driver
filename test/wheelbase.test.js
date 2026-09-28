import { describe, expect, it } from 'vitest';
import { DEFAULT_CAR } from '../src/vehicle/config.js';
import { ifsCorner, ifsRack, suspensionMounts } from '../src/vehicle/frame-geometry.js';
import { frameStretch, wheelMount } from '../src/vehicle/physics.js';

// Changing the wheelbase stretches the frame between the cab and each end: the wheels, their
// suspension and the steering rack move with the front and rear of the frame.
describe('wheelbase', () => {
  const car = (wheelBase, solidAxles = false) => ({ ...DEFAULT_CAR, wheelBase, solidAxles });

  it('puts the wheels at half the wheelbase, independent and solid axles', () => {
    for (const solid of [false, true]) {
      for (const wb of [2.5, 2.7, 3.1]) {
        const c = car(wb, solid);
        expect(wheelMount(0, c).x).toBeCloseTo(wb / 2, 6);
        expect(wheelMount(2, c).x).toBeCloseTo(-wb / 2, 6);
        if (!solid) {
          expect(ifsCorner(0, c).wheel.x).toBeCloseTo(wb / 2, 6);
          expect(ifsCorner(3, c).wheel.x).toBeCloseTo(-wb / 2, 6);
        }
      }
    }
  });

  it('moves the whole corner and the rack, so the arm geometry stays the same', () => {
    const base = car(2.7);
    const long = car(3.1);
    const d = frameStretch(long) - frameStretch(base);
    expect(d).toBeCloseTo(0.2, 6);
    for (const i of [0, 1, 2, 3]) {
      const a = ifsCorner(i, base);
      const b = ifsCorner(i, long);
      const sign = a.front ? 1 : -1;
      for (const key of ['wheel', 'lowerBall', 'upperBall', 'tieInner', 'tieOuter', 'shockBottom', 'shockTop']) {
        expect(b[key].x - a[key].x).toBeCloseTo(sign * d, 6);
        expect(b[key].y).toBeCloseTo(a[key].y, 6);
        expect(b[key].z).toBeCloseTo(a[key].z, 6);
      }
      for (const k of [0, 1]) expect(b.lowerInner[k].x - a.lowerInner[k].x).toBeCloseTo(sign * d, 6);
    }
    expect(ifsRack(long).center.x - ifsRack(base).center.x).toBeCloseTo(d, 6);
  });

  it('moves the solid-axle shock tops with the axles', () => {
    const a = suspensionMounts(0, car(2.7, true));
    const b = suspensionMounts(0, car(3.1, true));
    expect(b.shockTop.x - a.shockTop.x).toBeCloseTo(0.2, 6);
  });

  it('keeps the stretch within what the frame allows', () => {
    expect(frameStretch(car(1.6))).toBeGreaterThanOrEqual(-0.2);
    expect(frameStretch(car(4))).toBeLessThanOrEqual(0.6);
  });
});
