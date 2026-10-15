import RAPIER from '@dimforge/rapier3d-compat';
import { createWorld } from 'koota';
import { beforeAll, describe, expect, it } from 'vitest';
import { RockField } from '../src/ecs/traits.js';
import { createColliderStreamer } from '../src/physics/colliders.js';
import { CHUNK_SIZE } from '../src/terrain/chunk.js';
import { createHeightField } from '../src/terrain/height.js';
import { MAX_RIVALS, RIVAL_LIVERIES, configuredRivals, gridSlot, parseRivals } from '../src/vehicle/cars.js';
import { CAR, playerTires } from '../src/vehicle/config.js';

describe('other cars', () => {
  it('reads one car per entry from ?rivals=, each with its own tyre model', () => {
    expect(parseRivals('rigid,gpu:yellow, SOFT')).toEqual([
      { tires: 'rigid', livery: RIVAL_LIVERIES[0] },
      { tires: 'gpu', livery: 'yellow' },
      { tires: 'soft', livery: RIVAL_LIVERIES[2] },
    ]);
    expect(parseRivals('')).toEqual([]);
    expect(parseRivals(null)).toEqual([]);
    // Unknown tyre models are skipped, and there is a limit.
    expect(parseRivals('hover,rigid')).toEqual([{ tires: 'rigid', livery: RIVAL_LIVERIES[0] }]);
    expect(parseRivals(new Array(20).fill('rigid').join(','))).toHaveLength(MAX_RIVALS);
  });

  it('puts three rivals on the stadium unless ?rivals= says otherwise', () => {
    expect(configuredRivals('', 'stadium')).toHaveLength(3);
    expect(new Set(configuredRivals('', 'stadium').map((r) => r.livery)).size).toBe(3);
    expect(configuredRivals('?rivals=gpu', 'stadium')).toEqual([{ tires: 'gpu', livery: RIVAL_LIVERIES[0] }]);
    expect(configuredRivals('?rivals=', 'stadium')).toEqual([]);
    expect(configuredRivals('', 'canyon')).toEqual([]);
    expect(configuredRivals('')).toEqual([]);
  });

  it("takes the player's tyre model from the car settings", () => {
    const saved = { softTires: CAR.softTires, gpuTires: CAR.gpuTires };
    expect(playerTires({ softTires: true, gpuTires: true })).toBe('gpu');
    expect(playerTires({ softTires: true, gpuTires: false })).toBe('soft');
    expect(playerTires({ softTires: false, gpuTires: true })).toBe('rigid');
    expect(CAR).toMatchObject(saved);
  });

  it('lines the cars up behind the start, clear of each other', () => {
    for (const yaw of [0, 0.7, Math.PI / 2, -2.4]) {
      const slots = [0, 1, 2, 3, 4].map((n) => gridSlot(10, -5, yaw, n));
      expect(slots[0]).toMatchObject({ x: 10, z: -5, yaw });
      // Behind: against the way the cars face, (cos yaw, -sin yaw).
      const fx = Math.cos(yaw);
      const fz = -Math.sin(yaw);
      for (let n = 1; n < slots.length; n++) {
        const back = -((slots[n].x - 10) * fx + (slots[n].z + 5) * fz);
        expect(back).toBeGreaterThan(5);
        // Cars are 5 m long: centres at least that far apart along the line.
        const prev = slots[n - 1];
        const gap = (prev.x - slots[n].x) * fx + (prev.z - slots[n].z) * fz;
        expect(gap).toBeGreaterThan(5.2);
      }
    }
  });
});

describe('terrain colliders around several cars', () => {
  beforeAll(() => RAPIER.init());

  it('builds ground under every car and drops it once no car is near', () => {
    const physicsWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const ecs = createWorld();
    const heightAt = createHeightField({ mode: 'hills' });
    const streamer = createColliderStreamer({ rapier: RAPIER, world: physicsWorld, ecs, RockField, heightAt, rockCount: 0 });
    const far = { x: 10 * CHUNK_SIZE + 5, z: -6 * CHUNK_SIZE + 5 };
    // Is there ground under (x, z)? A ray down from high above.
    const ground = (p) => physicsWorld.step() ?? !!physicsWorld.castRay(new RAPIER.Ray({ x: p.x, y: 500, z: p.z }, { x: 0, y: -1, z: 0 }), 1000, true);

    streamer.update([{ x: 5, z: 5 }, far], { force: true });
    expect(ground({ x: 5, z: 5 })).toBe(true);
    expect(ground(far)).toBe(true);
    // Nothing between the two cars.
    expect(ground({ x: 5 * CHUNK_SIZE, z: -3 * CHUNK_SIZE })).toBe(false);

    // The far car goes: its ground goes with it; the first car's stays.
    streamer.update([{ x: 5, z: 5 }]);
    expect(ground({ x: 5, z: 5 })).toBe(true);
    expect(ground(far)).toBe(false);

    // A car that moves on gets the next chunk built, one job per call.
    const ahead = { x: 2 * CHUNK_SIZE + 5, z: 5 };
    for (let i = 0; i < 40; i++) streamer.update([{ x: 5, z: 5 }, { x: CHUNK_SIZE + 5, z: 5 }]);
    expect(ground(ahead)).toBe(true);
  });
});
