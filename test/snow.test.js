import { describe, expect, it } from 'vitest';
import { GroundDeformation, compactSoil } from '../src/terrain/deformation.js';
import { createHeightField } from '../src/terrain/height.js';
import { BARE_DEPTH, ROAD, SNOW } from '../src/terrain/snow.js';
import { DEFAULT_GPU_TIRE, effectiveGpuTire } from '../src/tire/config.js';
import { GROUND_N } from '../src/tire/gpu-tire-solver.js';
import { updateGpuGround } from '../src/tire/gpu-tires.js';

const snowField = createHeightField({ mode: 'snow' });

describe('snowfield', () => {
  it('is a plain of fresh snow on nearly flat ground', () => {
    expect(snowField.world).toBe('snow');
    expect(snowField.snow).toBe(SNOW);
    let lo = Infinity;
    let hi = -Infinity;
    for (let x = -500; x <= 500; x += 5) {
      for (let z = -500; z <= 500; z += 5) {
        if (snowField.roadDistance(x, z) < 8) continue;
        const h = snowField(x, z);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
        expect(snowField.snowAt(x, z).depth).toBeGreaterThan(0.2);
        expect(snowField.snowAt(x, z).firm).toBe(0);
      }
    }
    expect(hi - lo).toBeLessThan(1);
    // The same world on every load (and in every worker).
    expect(createHeightField({ mode: 'snow' })(123.4, -56.7)).toBe(snowField(123.4, -56.7));
  });

  it('has a ploughed road through the origin: bare asphalt with spots of packed snow', () => {
    expect(snowField.roadDistance(0, 0)).toBeLessThan(0.01);
    // Walk along the road: the car's heading follows it.
    let x = 0;
    let z = 0;
    let bare = 0;
    let spots = 0;
    let bareInTracks = 0;
    let inTracks = 0;
    for (let i = 0; i < 200; i++) {
      const yaw = snowField.roadHeading(x, z);
      // Across the road: (sin, cos) of the heading is perpendicular to it.
      for (let off = -2.9; off <= 2.9; off += 0.1) {
        const s = snowField.snowAt(x + Math.sin(yaw) * off, z + Math.cos(yaw) * off);
        expect(s.depth).toBeLessThan(0.03);
        expect(s.firm).toBe(1);
        const isBare = s.depth < BARE_DEPTH;
        if (isBare) bare++;
        else spots++;
        if (ROAD.tracks.some((t) => Math.abs(Math.abs(off) - t) < 0.2)) {
          inTracks++;
          if (isBare) bareInTracks++;
        }
      }
      x += Math.cos(yaw) * 0.5;
      z -= Math.sin(yaw) * 0.5;
    }
    expect(snowField.roadDistance(x, z)).toBeLessThan(0.3);
    const share = bare / (bare + spots);
    expect(share).toBeGreaterThan(0.5);
    expect(share).toBeLessThan(0.9);
    // Traffic keeps the wheel tracks a little clearer.
    expect(bareInTracks / inTracks).toBeGreaterThan(share);
  });

  it('has firm plough banks along both road edges, standing above the fresh snow', () => {
    // Along 40 m of the road, walked by its heading.
    for (const side of [-1, 1]) {
      let rise = 0;
      let x = 0;
      let z = 0;
      for (let i = 0; i < 20; i++) {
        const yaw = snowField.roadHeading(x, z);
        // Across the road: (sin, cos) of the heading is perpendicular to it.
        const at = (off) => [x + Math.sin(yaw) * off * side, z + Math.cos(yaw) * off * side];
        const crest = snowField.snowAt(...at(ROAD.bankCentre));
        expect(crest.depth).toBeGreaterThan(0.3);
        expect(crest.firm).toBeGreaterThan(ROAD.bankFirmness / 2);
        rise += (snowField(...at(ROAD.bankCentre)) - snowField(...at(12))) / 20;
        x += Math.cos(yaw) * 2;
        z -= Math.sin(yaw) * 2;
      }
      expect(rise).toBeGreaterThan(0.25);
    }
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
    const expected = SNOW.packRatio * SNOW.depth * Math.sqrt(45 / SNOW.bearing);
    expect(press(d, 30, 45)).toBeGreaterThan(expected * 0.95);
    expect(press(d, 300, 45)).toBeCloseTo(expected, 3);
  });

  it('lets aired-down tyres float higher, and never packs past the pack depth', () => {
    const low = press(new GroundDeformation(), 300, 30);
    const high = press(new GroundDeformation(), 300, 100);
    expect(low).toBeLessThan(high);
    expect(press(new GroundDeformation(), 300, 1000)).toBeCloseTo(SNOW.packRatio * SNOW.depth, 3);
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

  it('get how packed the snow is in the ground grid, and where it is bare asphalt', () => {
    const solver = { setGround() {} };
    const d = new GroundDeformation();
    const cell = 0.125;
    // Out on the plain (fresh snow) at z = 40.
    const iz = 40 / cell;
    const fresh = snowField.snowAt(1, 40);
    d.addCell(8, iz, -fresh.packDepth / 2); // half packed
    d.addCell(9, iz, -fresh.packDepth * 2); // dug deeper than a rut
    d.addCell(10, iz, 0.05); // piled up beside a rut
    updateGpuGround(solver, snowField, 1, 40, d, cell);
    const g = solver.groundCache;
    const at = (ix, jz) => g.grid[GROUND_N * GROUND_N + (jz - g.iz0) * GROUND_N + (ix - g.ix0)];
    expect(at(8, iz)).toBeCloseTo(0.5, 2);
    expect(at(9, iz)).toBe(1);
    expect(at(10, iz)).toBe(0);
    expect(at(20, iz + 12)).toBe(0);
    // A new rut is patched in without re-centring.
    d.addCell(12, iz + 12, -fresh.packDepth);
    updateGpuGround(solver, snowField, 1.1, 40, d, cell);
    expect(at(12, iz + 12)).toBeCloseTo(1, 2);

    // On the road: spots of packed snow (1) on bare asphalt (2).
    updateGpuGround(solver, snowField, 0, 0, d, cell);
    const road = solver.groundCache;
    const on = (x, z) => road.grid[GROUND_N * GROUND_N + (Math.round(z / cell) - road.iz0) * GROUND_N + (Math.round(x / cell) - road.ix0)];
    let packed = 0;
    let bare = 0;
    for (let x = -4; x <= 4; x += cell) {
      for (let z = -2; z <= 2; z += cell) {
        if (on(x, z) === 1) packed++;
        if (on(x, z) === 2) bare++;
      }
    }
    expect(packed).toBeGreaterThan(50);
    expect(bare).toBeGreaterThan(50);
  });
});
