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

describe('canyon terrain', () => {
  const heightAt = createHeightField({ seed: 1337, mode: 'canyon' });

  it('starts on a road', () => {
    expect(heightAt.roadDistance(0, 0)).toBeLessThan(0.5);
  });

  it('keeps roads drivable: gentle along and across the road', () => {
    // Walk 300 m along the road from the origin and check the grade.
    let x = 0;
    let z = 0;
    let yaw = heightAt.roadHeading(0, 0);
    let steepest = 0;
    for (let i = 0; i < 300; i++) {
      const fx = Math.cos(yaw);
      const fz = -Math.sin(yaw);
      const nx = x + fx;
      const nz = z + fz;
      steepest = Math.max(steepest, Math.abs(heightAt(nx, nz) - heightAt(x, z)));
      // Across the road: 2 m either side of the centre line.
      const side = Math.abs(heightAt(nx - fz * 2, nz + fx * 2) - heightAt(nx + fz * 2, nz - fx * 2)) / 4;
      expect(side).toBeLessThan(0.12);
      x = nx;
      z = nz;
      // Follow the road's heading, keeping the direction of travel.
      const h = heightAt.roadHeading(x, z);
      yaw = Math.cos(h - yaw) >= 0 ? h : h + Math.PI;
      expect(heightAt.roadDistance(x, z)).toBeLessThan(1.5);
    }
    expect(steepest).toBeLessThan(0.15); // under 15 % grade per metre
  });

  it('has cliffs away from the roads', () => {
    let tallest = 0;
    for (let x = -300; x <= 300; x += 10) for (let z = -300; z <= 300; z += 10) tallest = Math.max(tallest, heightAt(x, z));
    expect(tallest).toBeGreaterThan(25);
  });

  it('is deterministic', () => {
    expect(createHeightField({ seed: 5, mode: 'canyon' })(123, -45)).toBe(createHeightField({ seed: 5, mode: 'canyon' })(123, -45));
  });
});
