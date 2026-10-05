import { describe, expect, it } from 'vitest';
import { drawnSurface } from '../src/terrain/drawn-surface.js';
import { createHeightField } from '../src/terrain/height.js';
import { rockSheetData } from '../src/terrain/rock-sheet.js';

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

  it('follows the drawn rock sheet on the dry river, jittered triangles and all', () => {
    const h = createHeightField({ mode: 'river' });
    const drawn = drawnSurface(h);
    const sheet = rockSheetData(h, 0, 0);
    expect(sheet).not.toBeNull();
    const p = sheet.positions;
    let checked = 0;
    for (let t = 0; t < sheet.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((j) => sheet.indices[t + j] * 3);
      // Points inside the triangle: where the sheet is drawn over the ground, it is the surface.
      for (const [u, v] of [[1 / 3, 1 / 3], [0.7, 0.15], [0.15, 0.7]]) {
        const w = 1 - u - v;
        const x = u * p[a] + v * p[b] + w * p[c];
        const y = u * p[a + 1] + v * p[b + 1] + w * p[c + 1];
        const z = u * p[a + 2] + v * p[b + 2] + w * p[c + 2];
        if (drawn(x, z) > y + 1e-4) continue; // the ground is above the sheet here
        expect(drawn(x, z)).toBeCloseTo(y, 3);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
