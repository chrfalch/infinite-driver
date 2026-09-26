import { describe, expect, it } from 'vitest';
import { LUG_HEIGHT, createStaticMtTyre, evaluateLattice } from '../src/render/mt-tyre.js';
import { torusMesh } from '../src/tire/soft-tire.js';
import { TIRE } from '../src/tire/config.js';

const shape = { ...TIRE, segmentsAround: 40, segmentsAcross: 10 };

describe('mud-terrain tyre mesh', () => {
  it('passes through the particles and points its normal outward on both sides', () => {
    for (const mirror of [false, true]) {
      const m = torusMesh(shape, { mirror });
      const { p, n } = evaluateLattice(m.vertices, m.nu, m.nv, 7, 0, mirror ? -1 : 1);
      const k = (7 * m.nv) * 3;
      expect(p[0]).toBeCloseTo(m.vertices[k], 6);
      expect(p[1]).toBeCloseTo(m.vertices[k + 1], 6);
      // At the tread centre the outward normal is radial.
      const radial = [m.vertices[k], m.vertices[k + 1]];
      const len = Math.hypot(...radial);
      expect(n[0] * radial[0] / len + n[1] * radial[1] / len).toBeGreaterThan(0.99);
    }
  });

  it('puts the tread blocks one lug height outside the carcass', () => {
    const tyre = createStaticMtTyre(torusMesh(shape));
    const pos = tyre.geometry.getAttribute('position');
    let maxR = 0;
    for (let i = 0; i < pos.count; i++) maxR = Math.max(maxR, Math.hypot(pos.getX(i), pos.getY(i)));
    expect(maxR).toBeCloseTo(shape.outerRadius + LUG_HEIGHT, 2);
  });
});
