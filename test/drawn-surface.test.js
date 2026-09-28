import { describe, expect, it } from 'vitest';
import { drawnSurface } from '../src/terrain/drawn-surface.js';
import { createHeightField } from '../src/terrain/height.js';

describe('drawn ground surface', () => {
  it('matches the ground mesh: its vertices, and flat between them', () => {
    const h = createHeightField({ mode: 'canyon' });
    const drawn = drawnSurface(h);
    for (const [x, z] of [[3, 7], [-12, 40], [100, -5]]) {
      expect(drawn(x, z)).toBeCloseTo(h(x, z), 5);
      // Along a cell edge the mesh is a straight line between its vertices.
      expect(drawn(x + 0.5, z)).toBeCloseTo((h(x, z) + h(x + 1, z)) / 2, 5);
    }
  });

  it('is never below the drawn rock sheet on the dry river', () => {
    const h = createHeightField({ mode: 'river' });
    const drawn = drawnSurface(h);
    // On the bed's centre line the sheet covers the ground; its vertices are 25 cm apart.
    for (let x = 0; x < 20; x += 0.25) {
      const z = 0;
      if (h.roadDistance(Math.floor(x) + 0.5, 0.5) > 1) continue;
      expect(drawn(x, z)).toBeGreaterThanOrEqual(h.sample(x, z).h - 1e-5);
    }
  });
});
