import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, chunkTrimesh, sampleChunk, toRapierHeights } from '../src/terrain/chunk.js';
import { createHeightField } from '../src/terrain/height.js';

beforeAll(async () => {
  await RAPIER.init();
});

describe('terrain collider', () => {
  it('matches the height function at grid points', () => {
    const heightAt = createHeightField({ seed: 7, mode: "hills" });
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const res = 16;
    const cx = 2;
    const cz = -3;
    const heights = sampleChunk(heightAt, cx, cz, CHUNK_SIZE, res);
    const desc = RAPIER.ColliderDesc.heightfield(res, res, toRapierHeights(heights, res), {
      x: CHUNK_SIZE,
      y: 1,
      z: CHUNK_SIZE,
    }).setTranslation((cx + 0.5) * CHUNK_SIZE, 0, (cz + 0.5) * CHUNK_SIZE);
    world.createCollider(desc);
    world.step();

    const step = CHUNK_SIZE / res;
    for (const [ix, iz] of [[1, 1], [3, 12], [14, 5], [8, 8], [15, 2]]) {
      const x = cx * CHUNK_SIZE + ix * step;
      const z = cz * CHUNK_SIZE + iz * step;
      const ray = new RAPIER.Ray({ x, y: 500, z }, { x: 0, y: -1, z: 0 });
      const hit = world.castRay(ray, 1000, true);
      expect(hit).not.toBeNull();
      expect(500 - hit.timeOfImpact).toBeCloseTo(heightAt(x, z), 3);
    }
  });

  it('trimesh collider matches the height function at grid points', () => {
    const heightAt = createHeightField({ seed: 7, mode: 'hills' });
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const res = 16;
    const { vertices, indices } = chunkTrimesh(sampleChunk(heightAt, 1, 2, CHUNK_SIZE, res), 1, 2, CHUNK_SIZE, res);
    world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices));
    world.step();
    const step = CHUNK_SIZE / res;
    for (const [ix, iz] of [[1, 1], [3, 12], [14, 5]]) {
      const x = CHUNK_SIZE + ix * step;
      const z = 2 * CHUNK_SIZE + iz * step;
      const hit = world.castRay(new RAPIER.Ray({ x, y: 500, z }, { x: 0, y: -1, z: 0 }), 1000, true);
      expect(500 - hit.timeOfImpact).toBeCloseTo(heightAt(x, z), 3);
    }
  });

  it('is deterministic for a seed', () => {
    expect(createHeightField({ seed: 3, mode: "hills" })(10, 20)).toBe(createHeightField({ seed: 3, mode: "hills" })(10, 20));
  });
});
