import { describe, expect, it } from 'vitest';
import { focusPlane } from '../src/controls.js';

describe('focusPlane', () => {
  it('is the far-only look at 0', () => {
    expect(focusPlane(0)).toEqual({ dofRange: 35, dofStrength: 3, dofNear: 0 });
  });

  it('is the macro look at 1', () => {
    expect(focusPlane(1)).toEqual({ dofRange: 5, dofStrength: 5, dofNear: 5 });
  });

  it('lands near the tilt-shift look halfway', () => {
    const mid = focusPlane(0.5);
    expect(mid.dofRange).toBeGreaterThan(7);
    expect(mid.dofRange).toBeLessThan(11);
    expect(mid.dofNear).toBe(10);
    expect(mid.dofStrength).toBe(4);
  });

  it('narrows steadily and clamps outside 0-1', () => {
    let last = focusPlane(0);
    for (let t = 0.1; t <= 1; t += 0.1) {
      const next = focusPlane(t);
      expect(next.dofRange).toBeLessThan(last.dofRange);
      expect(next.dofStrength).toBeGreaterThan(last.dofStrength);
      last = next;
    }
    expect(focusPlane(-1)).toEqual(focusPlane(0));
    expect(focusPlane(2)).toEqual(focusPlane(1));
  });
});
