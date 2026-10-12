import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, chunkTrimesh, sampleChunk, toRapierHeights } from '../src/terrain/chunk.js';
import { createHeightField } from '../src/terrain/height.js';
import { generateRocks } from '../src/terrain/rocks.js';
import { ROCK_EDGE, SOIL_MIN } from '../src/terrain/riverbed.js';

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

  it('only climbs, toward +x (the way the car starts facing)', () => {
    expect(Math.cos(heightAt.roadHeading(0, 0))).toBeGreaterThan(0);
    const points = walkBed(3000);
    let prev = heightAt.sample(points[0].x, points[0].z).bedY;
    for (const p of points) {
      expect(p.x).toBeGreaterThan(-1);
      const y = heightAt.sample(p.x, p.z).bedY;
      expect(y).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = y;
    }
    expect(prev - heightAt.sample(points[0].x, points[0].z).bedY).toBeGreaterThan(200);
  });

  it('climbs in a staircase: level shelves of 5-10 m between short, steep risers of 2-3 m, all varied', () => {
    const step = 0.25;
    const ys = walkBed(2000, step).map((p) => heightAt.sample(p.x, p.z).bedY);
    // Runs of level and of climbing ground along the centre line.
    const runs = [];
    for (let i = 1; i < ys.length; i++) {
      const flat = (ys[i] - ys[i - 1]) / step < 0.03;
      if (runs.length && runs[runs.length - 1].flat === flat) {
        const r = runs[runs.length - 1];
        r.len += step;
        r.rise += ys[i] - ys[i - 1];
        r.peak = Math.max(r.peak, (ys[i] - ys[i - 1]) / step);
      } else runs.push({ flat, len: step, rise: ys[i] - ys[i - 1], peak: (ys[i] - ys[i - 1]) / step });
    }
    const inner = runs.slice(1, -1);
    const shelves = inner.filter((r) => r.flat).map((r) => r.len).sort((p, q) => p - q);
    const risers = inner.filter((r) => !r.flat);
    const deg = (g) => Math.atan(g) * (180 / Math.PI);
    const median = (v) => v[v.length >> 1];
    expect(risers.length).toBeGreaterThan(120);
    // Shelves 5-10 m (a little longer where the bed bends), varied.
    expect(median(shelves)).toBeGreaterThan(5.5);
    expect(median(shelves)).toBeLessThan(10);
    expect(shelves[Math.floor(shelves.length * 0.05)]).toBeGreaterThan(4);
    expect(shelves[Math.floor(shelves.length * 0.95)]).toBeLessThan(12);
    expect(shelves[Math.floor(shelves.length * 0.9)] - shelves[Math.floor(shelves.length * 0.1)]).toBeGreaterThan(3);
    // Risers 2-3 m long, rising 0.6-2 m: some gentle-ish, some very steep, none past ~38°.
    const lens = risers.map((r) => r.len).sort((p, q) => p - q);
    expect(median(lens)).toBeGreaterThan(2);
    expect(median(lens)).toBeLessThan(3.3);
    expect(lens[lens.length - 1]).toBeLessThan(4);
    const grades = risers.map((r) => deg(r.rise / r.len)).sort((p, q) => p - q);
    expect(grades[Math.floor(grades.length * 0.1)]).toBeLessThan(24);
    expect(grades[Math.floor(grades.length * 0.9)]).toBeGreaterThan(27);
    expect(deg(Math.max(...risers.map((r) => r.peak)))).toBeLessThan(38);
  });

  it('narrows and widens along its length: tight gaps between the walls and wide open stretches', () => {
    const points = walkBed(3000).filter((_, i) => i % 10 === 0);
    const widths = points.map((p) => heightAt.bedWidth(p.x, p.z));
    expect(Math.min(...widths)).toBeLessThan(1.6);
    expect(Math.max(...widths)).toBeGreaterThan(6.5);
    // Several separate narrow and wide stretches.
    const stretches = (test) => widths.filter((w, i) => test(w) && !(i > 0 && test(widths[i - 1]))).length;
    expect(stretches((w) => w < 2)).toBeGreaterThanOrEqual(3);
    expect(stretches((w) => w > 5.5)).toBeGreaterThanOrEqual(3);
    // Where it is narrow, the boulder walls close in just past the bed, but a lane for the car
    // (2.4 m over the tyres) stays low enough to drive.
    let wallSum = 0;
    let walls = 0;
    for (const p of points.filter((_, i) => widths[i] < 1.8)) {
      const side = [-Math.sin(p.yaw), -Math.cos(p.yaw)];
      const w = heightAt.bedWidth(p.x, p.z);
      for (const sgn of [1, -1]) {
        let wall = 0;
        for (let d = w + 1.5; d <= w + 3; d += 0.25) wall = Math.max(wall, heightAt.sample(p.x + side[0] * d * sgn, p.z + side[1] * d * sgn).stone);
        wallSum += wall;
        walls++;
        expect(heightAt.sample(p.x + side[0] * 1.2 * sgn, p.z + side[1] * 1.2 * sgn).stone).toBeLessThan(0.8);
      }
      expect(heightAt.sample(p.x, p.z).road).toBeGreaterThan(0.9);
    }
    expect(walls).toBeGreaterThan(20);
    expect(wallSum / walls).toBeGreaterThan(1);
  });

  it('has banks either side of the bed', () => {
    for (const p of walkBed(400).filter((_, i) => i % 40 === 0)) {
      const side = [-Math.sin(p.yaw), -Math.cos(p.yaw)];
      for (const s of [1, -1]) {
        const out = heightAt.bedWidth(p.x, p.z) + 6;
        const bank = heightAt(p.x + side[0] * out * s, p.z + side[1] * out * s);
        expect(bank).toBeGreaterThan(p.h + 0.2);
      }
    }
  });

  it('keeps the land outside the river level with the bank tops', () => {
    for (const p of walkBed(2000).filter((_, i) => i % 50 === 0)) {
      const side = [-Math.sin(p.yaw), -Math.cos(p.yaw)];
      const w = heightAt.bedWidth(p.x, p.z);
      for (const sgn of [1, -1]) {
        // From the bank top out into the forest, the ground stands 0.6-1.5 m over the bed beside
        // it (up to a riser more where it is beside one, plus small bumps): no hills over it.
        for (const d of [w + 7, w + 12, w + 25, w + 45]) {
          const s = heightAt.sample(p.x + side[0] * d * sgn, p.z + side[1] * d * sgn);
          expect(s.h - s.bedY).toBeGreaterThan(0.4);
          expect(s.h - s.bedY).toBeLessThan(4.5);
        }
      }
    }
  });

  it('floors the bed with one rock sheet, rising into boulder walls', () => {
    const points = walkBed(600).filter((_, i) => i % 4 === 0);
    let bedMax = 0;
    let soil = 0;
    let all = 0;
    let wallSum = 0;
    let walls = 0;
    for (const p of points) {
      const side = [-Math.sin(p.yaw), -Math.cos(p.yaw)];
      const w = heightAt.bedWidth(p.x, p.z);
      for (let d = -(w - 0.5); d <= w - 0.5; d += 0.5) {
        const s = heightAt.sample(p.x + side[0] * d, p.z + side[1] * d);
        // Rock or soil pockets, no ground showing between the humps; bare rock for the tyres except
        // in the pockets (soft, they take ruts), which are shallow.
        expect(s.stone).toBeGreaterThanOrEqual(0.04 - 1e-9);
        expect(s.soil).toBeLessThan(0.25);
        const x = p.x + side[0] * d;
        const z = p.z + side[1] * d;
        if (heightAt.soilAt(x, z) > SOIL_MIN) soil++;
        else expect(heightAt.rockAt(x, z)).toBe(true);
        all++;
        bedMax = Math.max(bedMax, s.stone);
      }
      for (const sgn of [1, -1]) {
        let top = 0;
        for (let d = w + 1; d <= w + 4; d += 0.25) top = Math.max(top, heightAt.sample(p.x + side[0] * d * sgn, p.z + side[1] * d * sgn).stone);
        wallSum += top;
        walls++;
      }
    }
    expect(bedMax).toBeLessThan(1.2); // the big slabs in the bed stand at most about a metre
    // Soil pockets cover some of the bed, not most of it.
    expect(soil / all).toBeGreaterThan(0.08);
    expect(soil / all).toBeLessThan(0.35);
    expect(wallSum / walls).toBeGreaterThan(1.0); // the walls stand over a metre
    // The forest beyond has only a few loose rocks.
  });

  it('marks the soil pockets on the drawn sheet where the tyres find soft ground', async () => {
    const { rockSheetData } = await import('../src/terrain/rock-sheet.js');
    const data = rockSheetData(heightAt, 0, -1);
    let deep = 0;
    let deepSoft = 0;
    let shallowRock = 0;
    let rockChecked = 0;
    for (let k = 0; k < data.ground.length / 4; k++) {
      const x = data.positions[k * 3];
      const z = data.positions[k * 3 + 2];
      const soil = data.ground[k * 4];
      if (soil > 0.05) {
        if (!heightAt.rockAt(x, z)) deepSoft++;
        deep++;
      } else if (soil === 0 && heightAt.bankDistance(x, z) < 4) {
        rockChecked++;
        if (heightAt.rockAt(x, z)) shallowRock++;
      }
    }
    expect(deep).toBeGreaterThan(50);
    // The tyres' soil depth is interpolated on a 25 cm grid, so the odd point in a narrow pocket or
    // beside one reads the other way.
    expect(deepSoft / deep).toBeGreaterThan(0.9);
    expect(shallowRock / rockChecked).toBeGreaterThan(0.9);
  });

  it('builds a connected rock mesh and collider for chunks on the bed', async () => {
    const { rockSheetData, rockSheetTrimesh, ROCK_COLLIDER_BANDS } = await import('../src/terrain/rock-sheet.js');
    const data = rockSheetData(heightAt, 0, -1);
    expect(data.positions.length).toBeGreaterThan(9 * 1000);
    let tris = 0;
    for (let band = 0; band < ROCK_COLLIDER_BANDS; band++) tris += (rockSheetTrimesh(heightAt, 0, -1, band)?.indices.length ?? 0) / 3;
    expect(tris).toBeGreaterThan(1000);
    // Far from any bed: nothing.
    expect(rockSheetData(heightAt, 3, 3)).toBeNull();
  });

  it('jitters the drawn sheet the same way either side of a chunk border, so the seam stays closed', async () => {
    const { rockSheetData } = await import('../src/terrain/rock-sheet.js');
    const key = (p, k) => `${p[k].toFixed(4)},${p[k + 2].toFixed(4)}`;
    const points = (data) => new Map(Array.from({ length: data.positions.length / 3 }, (_, i) => [key(data.positions, i * 3), data.positions[i * 3 + 1]]));
    const a = points(rockSheetData(heightAt, 0, -1));
    const b = points(rockSheetData(heightAt, -1, -1));
    let shared = 0;
    for (const [xz, y] of a) {
      if (!b.has(xz)) continue;
      shared++;
      expect(b.get(xz)).toBeCloseTo(y, 5);
    }
    expect(shared).toBeGreaterThan(20);
  });

  it('scatters small loose rocks and pebbles over the rock sheet', async () => {
    const { generatePebbles, PEBBLE_STRIDE } = await import('../src/terrain/rocks.js');
    const rocks = generateRocks(heightAt, 0, -1);
    const onBed = rocks.filter((r) => heightAt.bankDistance(r.x, r.z) < ROCK_EDGE);
    expect(onBed.length).toBeGreaterThan(40);
    // Small enough to drive over (the car's belly is 0.62 m up), and none on the spawn point.
    for (const r of onBed) {
      expect(r.size).toBeLessThanOrEqual(0.5);
      expect(Math.hypot(r.x, r.z)).toBeGreaterThan(3.5);
    }
    const pebbles = generatePebbles(heightAt, 0, -1);
    expect(pebbles.length / PEBBLE_STRIDE).toBeGreaterThan(300);
    for (let i = 0; i < pebbles.length; i += PEBBLE_STRIDE) {
      const [x, y, z, , size] = pebbles.subarray(i, i + PEBBLE_STRIDE);
      expect(size).toBeLessThan(0.09);
      expect(Math.abs(y - heightAt(x, z))).toBeLessThan(0.02);
    }
    // Only in the river world.
    expect(generatePebbles(createHeightField({ mode: 'canyon' }), 0, 0)).toBeNull();
  });

  it('keeps trees out of the bed', async () => {
    const { generatePlants } = await import('../src/terrain/vegetation.js');
    const plants = [];
    for (let cx = -2; cx < 2; cx++) for (let cz = -2; cz < 2; cz++) plants.push(...generatePlants(heightAt, cx, cz));
    const trees = plants.filter((p) => p.kind === 'tree');
    expect(trees.length).toBeGreaterThan(50);
    for (const t of trees) expect(heightAt.bankDistance(t.x, t.z)).toBeGreaterThan(10);
  });
});
