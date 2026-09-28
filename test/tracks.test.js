import { describe, expect, it } from 'vitest';
import { particleContact } from '../src/systems/tracks.js';

// A stiff tyre's contact patch is only a row or two of particles long, so rows join and leave it
// as the wheel rolls. The contact point must move smoothly with the hub, not jump by a row.
describe('tyre track contact', () => {
  // One ring of `n` particles of radius r around a hub at (x, h), turned by `angle`, flattened
  // onto the ground at y = 0 (the patch), in the stride-4 layout the GPU solver reads back.
  function ring(x, h, r, n, angle) {
    const out = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) {
      const a = angle + (k / n) * 2 * Math.PI;
      out[k * 4] = x + r * Math.sin(a);
      out[k * 4 + 1] = Math.max(0.02, h - r * Math.cos(a));
      out[k * 4 + 2] = 0;
    }
    return out;
  }

  it('keeps the contact under the hub as the particles roll through the patch', () => {
    const r = 0.55;
    const n = 40;
    const h = r - 0.012; // pressed 12 mm: a short patch, as on a hard tyre
    const offsets = [];
    for (let s = 0; s <= 40; s++) {
      const x = s * 0.01;
      const p = ring(x, h, r, n, -x / r);
      const c = particleContact(p, 4, 0, n, () => 0, 0.02);
      offsets.push(c.x - x);
    }
    const spread = Math.max(...offsets) - Math.min(...offsets);
    expect(spread).toBeLessThan(0.01);
  });

  it('reports no contact when every particle is clear of the ground', () => {
    const p = ring(0, 1, 0.5, 40, 0);
    expect(particleContact(p, 4, 0, 40, () => 0, 0.02)).toBeNull();
  });
});
