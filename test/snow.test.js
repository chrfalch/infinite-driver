import { describe, expect, it } from 'vitest';
import { GroundDeformation, compactSoil } from '../src/terrain/deformation.js';
import { createHeightField } from '../src/terrain/height.js';
import { SNOW } from '../src/terrain/snow.js';
import { DEFAULT_GPU_TIRE, effectiveGpuTire } from '../src/tire/config.js';
import { GROUND_N } from '../src/tire/gpu-tire-solver.js';
import { updateGpuGround } from '../src/tire/gpu-tires.js';

const snowField = createHeightField({ mode: 'snow' });

describe('snowfield', () => {
  it('is a flat plain of snow with only low drifts', () => {
    expect(snowField.world).toBe('snow');
    expect(snowField.snow).toBe(SNOW);
    let lo = Infinity;
    let hi = -Infinity;
    let steepest = 0;
    for (let x = -500; x <= 500; x += 5) {
      for (let z = -500; z <= 500; z += 5) {
        const h = snowField(x, z);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
        steepest = Math.max(steepest, Math.hypot(snowField(x + 0.5, z) - h, snowField(x, z + 0.5) - h) / 0.5);
      }
    }
    expect(hi - lo).toBeLessThan(1);
    expect(Math.atan(steepest) * (180 / Math.PI)).toBeLessThan(2);
    // The same world on every load (and in every worker).
    expect(createHeightField({ mode: 'snow' })(123.4, -56.7)).toBe(snowField(123.4, -56.7));
  });
});

// A patch of tread pressing on the same few cells, frame after frame.
function press(deformation, frames, pressureKpa, depth = 0.02) {
  const contacts = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) contacts.push({ x: i * 0.125, z: j * 0.125, depth });
  for (let f = 0; f < frames; f++) compactSoil(deformation, contacts, { softness: 0, dt: 1 / 60, right: { x: 0, z: 1 }, bermOffset: 0.3, snow: SNOW, pressureKpa });
  return -deformation.cellValue(1, 1);
}

describe('snow packing', () => {
  it('packs down until the snow bears the tyre pressure, then stops', () => {
    const d = new GroundDeformation();
    const expected = SNOW.packDepth * Math.sqrt(45 / SNOW.bearing);
    expect(press(d, 30, 45)).toBeGreaterThan(expected * 0.95);
    expect(press(d, 300, 45)).toBeCloseTo(expected, 3);
  });

  it('lets aired-down tyres float higher, and never packs past the pack depth', () => {
    const low = press(new GroundDeformation(), 300, 30);
    const high = press(new GroundDeformation(), 300, 100);
    expect(low).toBeLessThan(high);
    expect(press(new GroundDeformation(), 300, 1000)).toBeCloseTo(SNOW.packDepth, 3);
  });

  it('pushes a little snow up beside the rut', () => {
    const d = new GroundDeformation();
    press(d, 60, 45);
    expect(d.at(0.2, 0.5)).toBeGreaterThan(0);
  });

  it('works even with soil softness at zero', () => {
    expect(press(new GroundDeformation(), 10, 45)).toBeGreaterThan(0);
  });
});

describe('GPU tyres on snow', () => {
  it('trade soil for snow: soft fresh snow, firm packed snow, low grip, no gravel', () => {
    const s = effectiveGpuTire(DEFAULT_GPU_TIRE, false, { softness: 0.5, gravel: 1 }, SNOW);
    expect(s.snow).toBe(1);
    expect(s.soilStiffness).toBe(SNOW.freshStiffness);
    expect(s.packedStiffness).toBe(SNOW.packedStiffness);
    expect(s.friction).toBeCloseTo(DEFAULT_GPU_TIRE.friction * SNOW.freshGrip);
    expect(s.rockFriction).toBeCloseTo(DEFAULT_GPU_TIRE.friction * SNOW.packedGrip);
    expect(s.rockFriction).toBeLessThan(s.friction);
    expect(s.gravel).toBe(0);
    // Soil worlds are unchanged.
    expect(effectiveGpuTire(DEFAULT_GPU_TIRE, false, { softness: 0.5, gravel: 1 }, null).snow).toBeUndefined();
  });

  it('get how packed the snow is in the ground grid', () => {
    const solver = { setGround() {} };
    const d = new GroundDeformation();
    const cell = 0.125;
    d.addCell(8, 8, -SNOW.packDepth / 2); // half packed
    d.addCell(9, 8, -SNOW.packDepth * 2); // dug deeper than a rut
    d.addCell(10, 8, 0.05); // piled up beside a rut
    updateGpuGround(solver, snowField, 1, 1, d, cell);
    const g = solver.groundCache;
    const at = (ix, iz) => g.grid[GROUND_N * GROUND_N + (iz - g.iz0) * GROUND_N + (ix - g.ix0)];
    expect(at(8, 8)).toBeCloseTo(0.5, 3);
    expect(at(9, 8)).toBe(1);
    expect(at(10, 8)).toBe(0);
    expect(at(20, 20)).toBe(0);
    // A new rut is patched in without re-centring.
    d.addCell(12, 12, -SNOW.packDepth);
    updateGpuGround(solver, snowField, 1.1, 1, d, cell);
    expect(at(12, 12)).toBeCloseTo(1, 3);
  });
});
