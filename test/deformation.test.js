import { describe, expect, it } from 'vitest';
import { GroundDeformation, compactSoil, digPatch } from '../src/terrain/deformation.js';

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

  it('builds no berm on hard ground beside a rut (bare rock beside a soil pocket)', () => {
    const d = new GroundDeformation(0.125);
    const right = { x: 0, z: 1 };
    const hardAt = (x, z) => z > 2.1;
    for (let i = 0; i < 100; i++) {
      compactSoil(d, [{ x: 2, z: 2, depth: 0.1 }], { softness: 0.5, dt: 1 / 60, right, bermOffset: 0.25, hardAt });
    }
    expect(d.at(2, 2)).toBeLessThan(0);
    expect(d.at(2, 2.25)).toBe(0);
    expect(d.at(2, 1.75)).toBeGreaterThan(0);
  });

  it('leaves hard ground untouched', () => {
    const d = new GroundDeformation();
    compactSoil(d, [{ x: 0, z: 0, depth: 0.1 }], { softness: 0, dt: 1 / 60, right: { x: 1, z: 0 }, bermOffset: 0.2 });
    expect(d.tiles.size).toBe(0);
  });

  it('matches a plain per-cell lookup everywhere, including negative cells and tile borders', () => {
    const d = new GroundDeformation(0.125);
    const ref = new Map();
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 3000; i++) {
      const ix = Math.floor(rand() * 600) - 300;
      const iz = Math.floor(rand() * 600) - 300;
      const v = rand() - 0.5;
      d.addCell(ix, iz, v);
      ref.set(`${ix},${iz}`, (ref.get(`${ix},${iz}`) ?? 0) + v);
    }
    const cell = (ix, iz) => ref.get(`${ix},${iz}`) ?? 0;
    for (let i = 0; i < 3000; i++) {
      const ix = Math.floor(rand() * 600) - 300;
      const iz = Math.floor(rand() * 600) - 300;
      expect(d.cellValue(ix, iz)).toBeCloseTo(cell(ix, iz), 5);
    }
    // Bilinear lookups straddling tile borders (cells 127/128 and -1/0).
    for (const [x, z] of [[127.5 * 0.125, 3.3], [-0.06, -0.06], [15.99, 15.99], [-16.01, 5.02], [3.1, -32.03]]) {
      const gx = x / 0.125;
      const gz = z / 0.125;
      const ix = Math.floor(gx);
      const iz = Math.floor(gz);
      const fx = gx - ix;
      const fz = gz - iz;
      const want = (cell(ix, iz) * (1 - fx) + cell(ix + 1, iz) * fx) * (1 - fz) + (cell(ix, iz + 1) * (1 - fx) + cell(ix + 1, iz + 1) * fx) * fz;
      expect(d.at(x, z)).toBeCloseTo(want, 5);
    }
    // accumulate reads the same values as cellValue over a window crossing four tiles.
    const out = new Float32Array(200 * 150).fill(1);
    d.accumulate(-100, -60, 200, 150, out);
    for (let i = 0; i < 500; i++) {
      const c = Math.floor(rand() * 200);
      const r = Math.floor(rand() * 150);
      expect(out[r * 200 + c]).toBeCloseTo(1 + cell(-100 + c, -60 + r), 5);
    }
  });

  it('reports changes to several consumers asking in turn', () => {
    const d = new GroundDeformation(0.125);
    let a = d.version;
    let b = d.version;
    for (let frame = 0; frame < 10; frame++) {
      d.addCell(frame, 0, 0.1);
      // Each consumer sees its own changes since it last looked, never null.
      const ra = d.changedSince(a);
      a = d.version;
      expect(ra).toEqual({ x0: frame, z0: 0, x1: frame, z1: 0 });
      if (frame % 3 === 2) {
        const rb = d.changedSince(b);
        expect(rb).toEqual({ x0: frame - 2, z0: 0, x1: frame, z1: 0 });
        b = d.version;
      }
    }
    // One that fell far behind resamples everything.
    const stale = d.version;
    for (let i = 0; i < 40; i++) {
      d.addCell(i, 5, 0.1);
      d.changedSince(d.version - 1);
    }
    expect(d.changedSince(stale)).toBe(null);
  });

  it('reports the changed cells since a version', () => {
    const d = new GroundDeformation(0.125);
    d.addCell(1, 1, 0.1);
    let v = d.version;
    expect(d.changedSince(0)).toEqual({ x0: 1, z0: 1, x1: 1, z1: 1 });
    v = d.version;
    const none = d.changedSince(v);
    expect(none.x0 > none.x1).toBe(true);
    d.addCell(-5, 3, 0.1);
    d.add(10, 2, 0.1); // cells 80..81 x 16..17
    expect(d.changedSince(v)).toEqual({ x0: -5, z0: 3, x1: 81, z1: 17 });
    // A consumer that asks less often gets everything since its version.
    d.addCell(0, 0, 0.1);
    expect(d.changedSince(v)).toEqual({ x0: -5, z0: 0, x1: 81, z1: 17 });
    d.clear();
    expect(d.changedSince(d.version - 1)).toBe(null);
    expect(d.tiles.size).toBe(0);
    expect(d.cellValue(0, 0)).toBe(0);
  });

  it('digs out the whole patch, not a hole at its centre, and keeps deepening it to the limit', () => {
    const d = new GroundDeformation(0.125);
    const limit = () => 0.4;
    // A tyre spinning in place: the same patch, frame after frame.
    for (let i = 0; i < 2000; i++) digPatch(d, 2, 2, 1, 0, 0.16, 0.15, 0.0005, limit);
    const centre = -d.at(2, 2);
    // Across the tread (z) and along it (x), the rut is as deep near the edges as at the centre.
    expect(centre).toBeCloseTo(0.4, 3);
    expect(-d.at(2, 2.125)).toBeGreaterThan(0.3);
    expect(-d.at(2.125, 2)).toBeGreaterThan(0.3);
    // Nothing is dug outside the patch.
    expect(d.at(2, 2.4)).toBe(0);
    expect(d.at(2.4, 2)).toBe(0);
  });

  it('digs the volume it is given and skips hard ground', () => {
    const d = new GroundDeformation(0.125);
    const hardAt = (x, z) => z > 2;
    digPatch(d, 2, 2, 1, 0, 0.16, 0.15, 0.002, () => 0.4, hardAt);
    let volume = 0;
    for (let iz = 10; iz <= 22; iz++) for (let ix = 10; ix <= 22; ix++) volume -= d.cellValue(ix, iz) * 0.125 * 0.125;
    expect(volume).toBeCloseTo(0.002, 6);
    expect(d.at(2, 2.125)).toBe(0);
  });
});
