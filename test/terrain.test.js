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

describe('dry river terrain', () => {
  const heightAt = createHeightField({ mode: 'river' });

  // Points every 0.5 m along the bed centre line from the origin, `metres` long.
  function walkBed(metres, step = 0.5) {
    const points = [];
    let x = 0;
    let z = 0;
    let yaw = heightAt.roadHeading(0, 0);
    for (let s = 0; s < metres; s += step) {
      x += Math.cos(yaw) * step;
      z -= Math.sin(yaw) * step;
      const h = heightAt.roadHeading(x, z);
      yaw = Math.cos(h - yaw) >= 0 ? h : h + Math.PI;
      points.push({ x, z, yaw, h: heightAt(x, z) });
    }
    return points;
  }

  it('starts in the bed', () => {
    expect(heightAt.roadDistance(0, 0)).toBeLessThan(0.5);
    expect(heightAt.sample(0, 0).road).toBe(1);
  });

  it('keeps the bed gentle: under 10.5° over any 10 m, bumps of at most ~35 cm per metre', () => {
    const points = walkBed(2000);
    let steepest = 0;
    let worstBump = 0;
    for (let i = 20; i < points.length; i++) {
      steepest = Math.max(steepest, Math.abs(points[i].h - points[i - 20].h) / 10);
      worstBump = Math.max(worstBump, Math.abs(points[i].h - points[i - 2].h));
      expect(heightAt.roadDistance(points[i].x, points[i].z)).toBeLessThan(1.5);
    }
    expect(Math.atan(steepest)).toBeLessThan((10.5 * Math.PI) / 180);
    expect(worstBump).toBeLessThan(0.36);
  });

  it('goes up and down along the bed', () => {
    const hs = walkBed(3000).filter((_, i) => i % 10 === 0).map((p) => p.h);
    expect(Math.max(...hs) - Math.min(...hs)).toBeGreaterThan(6);
    // Both climbs and descents of at least 3 m.
    let climb = 0;
    let descent = 0;
    for (let i = 20; i < hs.length; i++) {
      climb = Math.max(climb, hs[i] - hs[i - 20]);
      descent = Math.max(descent, hs[i - 20] - hs[i]);
    }
    expect(climb).toBeGreaterThan(3);
    expect(descent).toBeGreaterThan(3);
  });

  it('has banks either side of the bed', () => {
    for (const p of walkBed(400).filter((_, i) => i % 40 === 0)) {
      const side = [-Math.sin(p.yaw), -Math.cos(p.yaw)];
      for (const s of [1, -1]) {
        const bank = heightAt(p.x + side[0] * 10 * s, p.z + side[1] * 10 * s);
        expect(bank).toBeGreaterThan(p.h + 0.2);
      }
    }
  });

  it('fills the bed with rocks, within the GPU tyres’ rock set', async () => {
    const { generateRocks } = await import('../src/terrain/rocks.js');
    const { MAX_ROCKS } = await import('../src/tire/gpu-tire-solver.js').catch(() => ({ MAX_ROCKS: 48 }));
    const rocks = [];
    for (let cx = -3; cx < 3; cx++) for (let cz = -3; cz < 3; cz++) rocks.push(...generateRocks(heightAt, cx, cz, { count: 70 }));
    for (const p of walkBed(150).filter((_, i) => i % 20 === 0)) {
      const near = rocks.filter((r) => Math.hypot(r.x - p.x, r.z - p.z) < 6.5 + r.size * 2).length;
      expect(near).toBeLessThanOrEqual(MAX_ROCKS * 0.8);
    }
    // The bed is full of rocks, but mid-bed they stay small enough to climb.
    const bed = rocks.filter((r) => r.bed);
    expect(bed.length).toBeGreaterThan(300);
    for (const r of rocks) if (heightAt.roadDistance(r.x, r.z) < 2.5) expect(r.size).toBeLessThan(0.67);
  });

  it('keeps trees out of the bed', async () => {
    const { generatePlants } = await import('../src/terrain/vegetation.js');
    const plants = [];
    for (let cx = -2; cx < 2; cx++) for (let cz = -2; cz < 2; cz++) plants.push(...generatePlants(heightAt, cx, cz));
    const trees = plants.filter((p) => p.kind === 'tree');
    expect(trees.length).toBeGreaterThan(50);
    for (const t of trees) expect(heightAt.roadDistance(t.x, t.z)).toBeGreaterThan(10);
  });
});
