import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildBuildings } from '../src/city/buildings.js';
import { indexRoads, NO_ROAD, roadAt } from '../src/city/roads.js';
import { clipRing, onTileEdge, ROAD_KIND } from '../src/city/vector-tiles.js';

beforeAll(async () => {
  await RAPIER.init();
});

const square = (x0, z0, s) => [
  { x: x0, z: z0 },
  { x: x0 + s, z: z0 },
  { x: x0 + s, z: z0 + s },
  { x: x0, z: z0 + s },
];

describe('tile clipping', () => {
  it('clips a ring to the tile and marks the cut edges', () => {
    const ring = clipRing([[-10, 10], [50, 10], [50, 50], [-10, 50]], 4096);
    expect(ring.length).toBe(4);
    expect(Math.min(...ring.map((p) => p[0]))).toBe(0);
    const cut = ring.map((p, i) => onTileEdge(p, ring[(i + 1) % ring.length], 4096));
    expect(cut.filter(Boolean).length).toBe(1);
  });
  it('drops rings outside the tile', () => {
    expect(clipRing([[-50, -50], [-10, -50], [-10, -10]], 4096)).toEqual([]);
  });
});

describe('buildings', () => {
  const flat = () => 10;
  const building = (overrides = {}) => ({
    outer: square(0, 0, 20),
    outerWalls: [true, true, true, true],
    holes: [],
    holeWalls: [],
    height: 12,
    minHeight: 0,
    colour: null,
    ...overrides,
  });

  it('builds walls facing out and a roof facing up', () => {
    const { positions, normals, solids, walls } = buildBuildings([building()], flat);
    expect(solids).toHaveLength(1);
    expect(walls).toHaveLength(4);
    expect(walls[0].length).toBeCloseTo(20, 5);
    const count = positions.length / 3;
    // 4 walls x 2 triangles + 2 roof triangles.
    expect(count).toBe(4 * 6 + 2 * 3);
    for (let t = 0; t < count; t += 3) {
      const p = (k) => [positions[(t + k) * 3], positions[(t + k) * 3 + 1], positions[(t + k) * 3 + 2]];
      const [a, b, c] = [p(0), p(1), p(2)];
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      // Triangle winding agrees with the stored normal (front faces point outwards).
      const dot = n[0] * normals[t * 3] + n[1] * normals[t * 3 + 1] + n[2] * normals[t * 3 + 2];
      expect(dot).toBeGreaterThan(0);
      // Wall normals point away from the centre (10, 10).
      if (normals[t * 3 + 1] === 0) {
        const cx = (a[0] + b[0] + c[0]) / 3 - 10;
        const cz = (a[2] + b[2] + c[2]) / 3 - 10;
        expect(cx * normals[t * 3] + cz * normals[t * 3 + 2]).toBeGreaterThan(0);
      }
    }
    expect(solids[0].max.y).toBe(22);
    expect(solids[0].min.y).toBeLessThan(10);
  });

  it('works for either ring direction and skips cut walls', () => {
    const reversed = building({ outer: square(0, 0, 20).reverse(), outerWalls: [true, false, true, true] });
    const { positions, normals } = buildBuildings([reversed], flat);
    expect(positions.length / 3).toBe(3 * 6 + 2 * 3);
    for (let t = 0; t < positions.length / 3; t += 3) {
      if (normals[t * 3 + 1] !== 0) continue;
      const cx = positions[t * 3] - 10;
      const cz = positions[t * 3 + 2] - 10;
      expect(cx * normals[t * 3] + cz * normals[t * 3 + 2]).toBeGreaterThan(0);
    }
  });

  it('is a solid the car cannot drive through', () => {
    const { solids } = buildBuildings([building()], flat);
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.createCollider(RAPIER.ColliderDesc.trimesh(solids[0].vertices, solids[0].indices));
    world.step();
    // A ray driving east at 12 m hits the west wall at x = 0.
    const hit = world.castRay(new RAPIER.Ray({ x: -5, y: 12, z: 10 }, { x: 1, y: 0, z: 0 }), 50, true);
    expect(hit?.timeOfImpact).toBeCloseTo(5, 3);
    // And from above it lands on the roof.
    const roof = world.castRay(new RAPIER.Ray({ x: 10, y: 100, z: 10 }, { x: 0, y: -1, z: 0 }), 200, true);
    expect(100 - roof.timeOfImpact).toBeCloseTo(22, 3);
  });
});

describe('roads', () => {
  const buckets = indexRoads([
    { points: [{ x: 0, z: 0 }, { x: 100, z: 0 }], half: 4, kind: ROAD_KIND.CAR },
    { points: [{ x: 0, z: 6 }, { x: 100, z: 6 }], half: 1.2, kind: ROAD_KIND.PATH },
  ]);
  const segs = [...new Set([...buckets.values()].flat())];
  const out = new Float32Array(4);

  it('measures the distance to the road edge and centre', () => {
    roadAt(segs, 50, 1, out);
    expect(out[0]).toBeCloseTo(-3, 5);
    expect(out[1]).toBeCloseTo(1, 5);
    expect(out[2]).toBeCloseTo(3.8, 5);
    expect(out[3]).toBe(4);
  });
  it('keeps the footpath beside the road as its own distance', () => {
    roadAt(segs, 50, 6, out);
    expect(out[0]).toBeCloseTo(2, 5);
    expect(out[2]).toBeCloseTo(-1.2, 5);
  });
  it('stops the distances just past the sidewalk far away', () => {
    roadAt(segs, 50, 40, out);
    expect(out[0]).toBe(NO_ROAD);
    expect(out[2]).toBe(NO_ROAD);
  });
});
