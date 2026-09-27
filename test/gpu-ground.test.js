import { describe, expect, it } from 'vitest';
import { GroundDeformation } from '../src/terrain/deformation.js';
import { GROUND_N } from '../src/tire/gpu-tire-solver.js';
import { gpuGroundHeight, updateGpuGround } from '../src/tire/gpu-tires.js';

const heightAt = (x, z) => Math.sin(x * 0.3) + Math.cos(z * 0.2) * 0.5;

function fakeSolver() {
  return {
    uploads: 0,
    groundOrigin: { x: 0, z: 0 },
    setGround(heights, x, z, cell) {
      this.uploads++;
      this.heights = heights.slice();
      this.groundOrigin = { x, z };
      this.groundCell = cell;
    },
  };
}

// Every grid sample equals terrain height plus the rut offset of its cell.
function expectExact(solver, deformation, cell = 0.125) {
  const { x: ox, z: oz } = solver.groundOrigin;
  const ix0 = Math.round(ox / cell);
  const iz0 = Math.round(oz / cell);
  let worst = 0;
  for (let iz = 0; iz < GROUND_N; iz++) {
    for (let ix = 0; ix < GROUND_N; ix++) {
      const want = heightAt(ox + ix * cell, oz + iz * cell) + deformation.cellValue(ix0 + ix, iz0 + iz);
      worst = Math.max(worst, Math.abs(want - solver.heights[iz * GROUND_N + ix]));
    }
  }
  expect(worst).toBeLessThan(1e-5);
}

describe('GPU ground grid', () => {
  it('only re-centres after the car moves a metre, and stays exact while ruts change', () => {
    const d = new GroundDeformation(0.125);
    const s = fakeSolver();
    updateGpuGround(s, heightAt, 0.3, -0.2, d);
    expect(s.uploads).toBe(1);
    expectExact(s, d);
    const origin = { ...s.groundOrigin };
    // Small moves without rut changes: nothing to do.
    for (let i = 0; i < 5; i++) updateGpuGround(s, heightAt, 0.3 + i * 0.1, -0.2, d);
    expect(s.uploads).toBe(1);
    expect(s.groundOrigin).toEqual(origin);
    // A rut inside the window is patched in.
    d.add(1, 1, -0.05);
    updateGpuGround(s, heightAt, 0.5, -0.2, d);
    expect(s.uploads).toBe(2);
    expectExact(s, d);
    // A change outside the window still bumps the version but needs no new values.
    d.add(100, 100, -0.05);
    updateGpuGround(s, heightAt, 0.5, -0.2, d);
    expect(s.uploads).toBe(2);
    // Driving on: re-centres (reusing the overlap) while digging.
    for (let i = 0; i < 60; i++) {
      const x = 0.3 + i * 0.37;
      const z = -0.2 - i * 0.11;
      d.add(x + 0.7, z + 1.1, -0.01);
      d.add(x - 0.7, z - 1.1, 0.004);
      updateGpuGround(s, heightAt, x, z, d);
      const half = ((GROUND_N - 1) * 0.125) / 2;
      expect(Math.abs(s.groundOrigin.x + half - x)).toBeLessThan(1.001);
      expect(Math.abs(s.groundOrigin.z + half - z)).toBeLessThan(1.001);
      expectExact(s, d);
    }
    // Clearing the ruts resamples everything.
    d.clear();
    updateGpuGround(s, heightAt, 22, -6.7, d);
    expectExact(s, d);
  });

  it('resamples fully when asked to (groundReady false) and without a deformation map', () => {
    const s = fakeSolver();
    updateGpuGround(s, heightAt, 5, 5, null);
    expect(s.uploads).toBe(1);
    updateGpuGround(s, heightAt, 5.2, 5, null);
    expect(s.uploads).toBe(1);
    s.groundReady = false;
    updateGpuGround(s, heightAt, 5.2, 5, null);
    expect(s.uploads).toBe(2);
    expectExact(s, new GroundDeformation());
  });
});

describe('gpuGroundHeight', () => {
  it('matches terrain plus ruts inside the grid and returns null outside it', () => {
    const d = new GroundDeformation(0.125);
    d.add(2, 1, -0.08);
    const s = fakeSolver();
    updateGpuGround(s, heightAt, 1.7, 0.4, d);
    let worst = 0;
    for (let k = 0; k < 500; k++) {
      const x = 1.7 + Math.sin(k * 12.9898) * 7;
      const z = 0.4 + Math.cos(k * 78.233) * 7;
      worst = Math.max(worst, Math.abs(gpuGroundHeight(s, x, z) - (heightAt(x, z) + d.at(x, z))));
    }
    // Linear interpolation on a 12.5 cm grid of a smooth field.
    expect(worst).toBeLessThan(0.01);
    expect(gpuGroundHeight(s, 1.7 + 20, 0.4)).toBeNull();
    expect(gpuGroundHeight(fakeSolver(), 0, 0)).toBeNull();
  });
});
