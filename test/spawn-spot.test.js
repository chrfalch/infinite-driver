import { describe, expect, it } from 'vitest';
import { createHeightField } from '../src/terrain/height.js';
import { WATER_LEVEL } from '../src/terrain/town.js';
import { findSpawnSpot, footprint } from '../src/vehicle/spawn.js';

// No rocks or trees loaded: only the ground decides.
const world = { query: () => [] };

describe('respawn spot', () => {
  it('keeps the car out of the water in town', () => {
    const heightAt = createHeightField({ mode: 'daytown' });
    let tried = 0;
    // Cars that ended up in the river or a pond, and cars on the banks beside them.
    for (let x = -900; x <= 900 && tried < 60; x += 7) {
      for (let z = -900; z <= 900 && tried < 60; z += 13) {
        if (heightAt(x, z) > WATER_LEVEL + 0.5) continue;
        tried++;
        const spot = findSpawnSpot(world, heightAt, x, z, (x + z) % 6);
        expect(footprint(heightAt, spot.x, spot.z, spot.yaw).min).toBeGreaterThan(WATER_LEVEL + 0.3);
      }
    }
    expect(tried).toBe(60);
  });
});
