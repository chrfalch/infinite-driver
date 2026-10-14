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

  it('climbs in a staircase: level shelves (cascades and long runs) between short risers, gentler up the spillways', () => {
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
    // The centre line runs up the spillways as often as not (the low channel wanders across it), so
    // its risers are 2-6.5 m long. Its shelves are bunched into cascades of short ones and spread
    // into long level runs: no steady beat.
    expect(median(shelves)).toBeGreaterThan(3);
    expect(median(shelves)).toBeLessThan(8);
    expect(shelves[Math.floor(shelves.length * 0.95)]).toBeGreaterThan(10);
    expect(shelves[shelves.length - 1]).toBeGreaterThan(15);
    expect(shelves[shelves.length - 1]).toBeLessThan(30);
    const lens = risers.map((r) => r.len).sort((p, q) => p - q);
    expect(lens[0]).toBeGreaterThan(1.75);
    expect(lens[lens.length - 1]).toBeLessThan(7);
    // Rising 0.6-2 m: some gentle, some steep, none past ~38°.
    const grades = risers.map((r) => deg(r.rise / r.len)).sort((p, q) => p - q);
    expect(grades[Math.floor(grades.length * 0.1)]).toBeLessThan(15);
    expect(grades[Math.floor(grades.length * 0.9)]).toBeGreaterThan(17);
    expect(deg(Math.max(...risers.map((r) => r.peak)))).toBeLessThan(38);
  });

  it('carves a spillway into every step: a gentler slot where the low channel crosses it, a pool below', () => {
    const step = 0.25;
    const points = walkBed(1500, step);
    const ys = points.map((p) => heightAt.sample(p.x, p.z).bedY);
    let steps = 0;
    let spilled = 0;
    let gentler = 0;
    let pools = 0;
    for (let i = 8; i < ys.length - 40; i++) {
      // The middle of each riser on the centre line.
      if (!((ys[i] - ys[i - 1]) / step > 0.15 && (ys[i - 1] - ys[i - 2]) / step <= 0.15)) continue;
      const p = points[i];
      const side = [-Math.sin(p.yaw), -Math.cos(p.yaw)];
      const ahead = [Math.cos(p.yaw), -Math.sin(p.yaw)];
      const w = heightAt.bedWidth(p.x, p.z);
      if (w < 3) continue;
      steps++;
      const at = (d, o) => heightAt.sample(p.x + side[0] * d + ahead[0] * o, p.z + side[1] * d + ahead[1] * o);
      // Where across the bed the spillway is.
      let best = 0;
      let spillD = 0;
      for (let d = -(w - 0.5); d <= w - 0.5; d += 0.25) {
        const s = at(d, 1).spill;
        if (s > best) [best, spillD] = [s, d];
      }
      if (best < 0.6) continue;
      spilled++;
      // The steepest pitch of the ground beneath the rocks along the bed through the spillway, and
      // 3 m to one side of it (if the bed is there).
      const pitch = (d) => {
        let g = 0;
        for (let o = -7; o < 3; o += 0.25) g = Math.max(g, (at(d, o + 0.25).under - at(d, o).under) / 0.25);
        return g;
      };
      const other = Math.abs(spillD + 3) < w - 0.5 ? spillD + 3 : spillD - 3;
      if (pitch(spillD) < pitch(other) * 0.85) gentler++;
      // A pool: the ground beneath the rocks dips at the foot of the step, lower than the shelf a
      // couple of metres further down.
      let low = Infinity;
      let lowAt = 0;
      for (let o = -5; o < 0; o += 0.25) if (at(spillD, o).under < low) [low, lowAt] = [at(spillD, o).under, o];
      if (low < at(spillD, lowAt - 2).under - 0.08) pools++;
    }
    expect(steps).toBeGreaterThan(50);
    expect(spilled / steps).toBeGreaterThan(0.85);
    expect(gentler / spilled).toBeGreaterThan(0.75);
    expect(pools / spilled).toBeGreaterThan(0.5);
  });

  it('keeps the risers bare rock: no gravel ramps', () => {
    const step = 0.25;
    const points = walkBed(1000, step);
    const ys = points.map((p) => heightAt.sample(p.x, p.z).bedY);
    const shares = [];
    let soil = 0;
    let all = 0;
    for (let i = 1; i < ys.length; i++) {
      const climbing = (ys[i] - ys[i - 1]) / step > 0.2;
      if (climbing) {
        const p = points[i];
        const side = [-Math.sin(p.yaw), -Math.cos(p.yaw)];
        const w = heightAt.bedWidth(p.x, p.z);
        for (let d = -(w - 0.5); d <= w - 0.5; d += 0.25) {
          all++;
          if (heightAt.soilAt(p.x + side[0] * d, p.z + side[1] * d) > SOIL_MIN) soil++;
        }
      } else if (all) {
        shares.push(soil / all);
        soil = all = 0;
      }
    }
    shares.sort((p, q) => p - q);
    expect(shares.length).toBeGreaterThan(60);
    expect(shares[shares.length >> 1]).toBeLessThan(0.12);
    expect(shares[Math.floor(shares.length * 0.95)]).toBeLessThan(0.35);
  });

  it('wanders the step edges across the bed instead of running them straight across', () => {
    // Where a riser starts at one side of a wide stretch of bed and where at the other: some way
    // apart along the bed, by a different amount at each step.
    const offsets = [];
    const points = walkBed(1500, 0.25);
    for (const p of points.filter((_, i) => i % 4 === 0)) {
      if (heightAt.bedWidth(p.x, p.z) < 5) continue;
      const side = [-Math.sin(p.yaw), -Math.cos(p.yaw)];
      const ahead = [Math.cos(p.yaw), -Math.sin(p.yaw)];
      const floorAt = (d, o) => heightAt.sample(p.x + side[0] * d + ahead[0] * o, p.z + side[1] * d + ahead[1] * o).h;
      // Only where the centre line is at the foot of a riser.
      const c0 = heightAt.sample(p.x, p.z).bedY;
      const c1 = heightAt.sample(p.x + ahead[0] * 0.5, p.z + ahead[1] * 0.5).bedY;
      if (c1 - c0 < 0.15) continue;
      const startAt = (d) => {
        let lo = floorAt(d, -8);
        for (let o = -8; o <= 8; o += 0.25) if (floorAt(d, o) - lo > 0.6) return o;
        return NaN;
      };
      const a = startAt(3.5);
      const b = startAt(-3.5);
      if (Number.isFinite(a) && Number.isFinite(b)) offsets.push(Math.abs(a - b));
    }
    offsets.sort((p, q) => p - q);
    expect(offsets.length).toBeGreaterThan(15);
    expect(offsets[offsets.length >> 1]).toBeGreaterThan(0.7);
    expect(offsets[Math.floor(offsets.length * 0.9)]).toBeGreaterThan(1.8);
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

  it('tops the boulder walls flush with the ground outside the river', () => {
    const over = [];
    for (const p of walkBed(2000).filter((_, i) => i % 20 === 0)) {
      const side = [-Math.sin(p.yaw), -Math.cos(p.yaw)];
      const ahead = [Math.cos(p.yaw), -Math.sin(p.yaw)];
      const w = heightAt.bedWidth(p.x, p.z);
      for (const sgn of [1, -1]) {
        const at = (d, o = 0) => heightAt(p.x + side[0] * d * sgn + ahead[0] * o, p.z + side[1] * d * sgn + ahead[1] * o);
        // The ground just outside, a few metres either way (it steps up with the bed's stairs).
        let land = -Infinity;
        for (let o = -4; o <= 4; o++) land = Math.max(land, at(w + 10, o));
        let wall = -Infinity;
        for (let d = w; d <= w + 6; d += 0.25) wall = Math.max(wall, at(d));
        over.push(wall - land);
      }
    }
    over.sort((p, q) => p - q);
    // The wall tops reach the ground level and (bar the odd bend, where the ground's steps fan
    // out) stay under it.
    expect(over[over.length >> 1]).toBeGreaterThan(-0.6);
    expect(over[over.length >> 1]).toBeLessThan(0.1);
    expect(over[Math.floor(over.length * 0.9)]).toBeLessThan(0.3);
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
