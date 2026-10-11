import { describe, expect, it } from 'vitest';
import { createHeightField } from '../src/terrain/height.js';
import { createTileBuilder, forwardOf, headingUpAngle } from '../src/ui/minimap.js';

const turn = (a, x, y) => ({ x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) });

describe('minimap', () => {
  it('turns the map so the car points up', () => {
    // Map space: +x right, +y down (world +z). "Up" is (0, -1).
    for (const yaw of [0, 0.7, 2, -2.5]) {
      const f = forwardOf({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
      const up = turn(headingUpAngle(f.x, f.z), f.x, f.z);
      expect(up.x).toBeCloseTo(0, 6);
      expect(up.y).toBeCloseTo(-1, 6);
    }
  });

  it('finds the forward axis (+x) of an unturned car', () => {
    expect(forwardOf({ x: 0, y: 0, z: 0, w: 1 })).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('builds a tile in steps, with the road drawn lighter than the ground', () => {
    const heightAt = createHeightField({ mode: 'canyon' });
    let t = 0;
    const tile = createTileBuilder(heightAt, 0, 0, { half: 60, px: 48, now: () => (t += 1) });
    let steps = 0;
    while (!tile.step(4)) steps++;
    expect(steps).toBeGreaterThan(3);
    const at = (x, z) => {
      const i = Math.floor(((x + 60) / 120) * 48);
      const j = Math.floor(((z + 60) / 120) * 48);
      const k = (j * 48 + i) * 4;
      return tile.pixels[k] + tile.pixels[k + 1] + tile.pixels[k + 2];
    };
    // The car starts on the road at the origin; off to the side of it is ground.
    expect(heightAt.roadDistance(0, 0)).toBeLessThan(1);
    let off = null;
    for (const [x, z] of [[0, 40], [0, -40], [40, 0], [-40, 0]]) if (heightAt.roadDistance(x, z) > 15) off = [x, z];
    expect(off).not.toBeNull();
    expect(at(0, 0)).toBeGreaterThan(at(...off) + 60);
    expect(tile.pixels.every((v, i) => i % 4 !== 3 || v === 255)).toBe(true);
  });
});
