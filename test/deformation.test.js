import { describe, expect, it } from 'vitest';
import { GroundDeformation, compactSoil } from '../src/terrain/deformation.js';

describe('ground deformation', () => {
  it('stores offsets across tiles and interpolates between cells', () => {
    const d = new GroundDeformation(0.125);
    d.addCell(-1, -1, -0.1);
    d.addCell(127, 127, 0.05);
    d.addCell(128, 127, 0.05);
    expect(d.cellValue(-1, -1)).toBeCloseTo(-0.1);
    expect(d.at(-0.125, -0.125)).toBeCloseTo(-0.1);
    expect(d.at(127.5 * 0.125, 127 * 0.125)).toBeCloseTo(0.05);
    expect(d.tiles.size).toBe(3);
  });

  it('compacts soil toward a softness limit and builds berms beside the rut', () => {
    const d = new GroundDeformation(0.125);
    const right = { x: 0, z: 1 };
    for (let i = 0; i < 400; i++) {
      compactSoil(d, [{ x: 2, z: 2, depth: 0.1 }], { softness: 0.5, dt: 1 / 60, right, bermOffset: 0.25 });
    }
    const rut = -d.at(2, 2);
    expect(rut).toBeGreaterThan(0.05);
    expect(rut).toBeLessThanOrEqual(0.22 * 0.5 + 1e-6);
    expect(d.at(2, 2.25)).toBeGreaterThan(0);
    expect(d.at(2, 1.75)).toBeGreaterThan(0);
  });

  it('leaves hard ground untouched', () => {
    const d = new GroundDeformation();
    compactSoil(d, [{ x: 0, z: 0, depth: 0.1 }], { softness: 0, dt: 1 / 60, right: { x: 1, z: 0 }, bermOffset: 0.2 });
    expect(d.tiles.size).toBe(0);
  });
});
