import { describe, expect, it } from 'vitest';
import { WaterWaves } from '../src/render/water-waves.js';

const run = (waves, seconds) => {
  for (let t = 0; t < seconds; t += 1 / 60) waves.update(1 / 60);
};

describe('water waves', () => {
  it('a blow spreads out as a ring', () => {
    const waves = new WaterWaves(() => 1);
    waves.follow(0, 0);
    waves.impulse(0, 0, 0.5, -1);
    run(waves, 1);
    // The middle has fallen back; the ring is a couple of metres out (c = sqrt(g) ≈ 3 m/s).
    const ring = Math.max(...[1.5, 2, 2.5, 3, 3.5].map((r) => Math.abs(waves.heightAt(r, 0))));
    expect(ring).toBeGreaterThan(Math.abs(waves.heightAt(0.1, 0.1)));
    expect(ring).toBeGreaterThan(1e-4);
  });

  it('dry ground holds still', () => {
    const waves = new WaterWaves((x) => (x < 2 ? 1 : -1));
    waves.follow(0, 0);
    waves.impulse(0, 0, 0.5, -1);
    run(waves, 2);
    expect(waves.heightAt(4, 0)).toBe(0);
    expect(Math.abs(waves.heightAt(1, 0))).toBeGreaterThan(0);
  });

  it('a moving push heaves the water ahead and leaves a wake', () => {
    const waves = new WaterWaves(() => 1);
    waves.follow(0, 0);
    for (let k = 0; k < 60; k++) {
      waves.push(-5 + k * 0.15, 0, 0.4, 0.3);
      waves.update(1 / 60);
    }
    let energy = 0;
    for (let x = -6; x < 4; x += 0.25) energy += Math.abs(waves.heightAt(x, 1));
    expect(energy).toBeGreaterThan(0.01);
  });

  it('keeps its waves where they were when it follows the car', () => {
    const waves = new WaterWaves(() => 1);
    waves.follow(0, 0);
    waves.impulse(3, 3, 0.5, -1);
    run(waves, 0.1);
    const before = waves.heightAt(3.1, 3.1);
    expect(waves.follow(10, -6)).toBe(true);
    expect(waves.heightAt(3.1, 3.1)).toBeCloseTo(before, 6);
  });

  it('goes to sleep once calm, and is exactly flat', () => {
    const waves = new WaterWaves(() => 1);
    waves.follow(0, 0);
    waves.impulse(0, 0, 0.5, -0.2);
    run(waves, 40);
    expect(waves.active).toBe(false);
    expect(waves.h.every((h) => h === 0)).toBe(true);
    expect(waves.update(1 / 60)).toBe(false);
  });

  it('stays bounded under strong, repeated pushes', () => {
    const waves = new WaterWaves(() => 1.3);
    waves.follow(0, 0);
    for (let k = 0; k < 600; k++) {
      waves.push(Math.sin(k * 0.05) * 8, Math.cos(k * 0.03) * 8, 1, 0.9);
      waves.impulse(0, 0, 0.6, k % 30 === 0 ? -4 : 0);
      waves.update(1 / 30);
    }
    const peak = waves.h.reduce((m, h) => Math.max(m, Math.abs(h)), 0);
    expect(Number.isFinite(peak)).toBe(true);
    expect(peak).toBeLessThan(2);
  });
});
