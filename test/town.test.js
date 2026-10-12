import { describe, expect, it } from 'vitest';
import { createHeightField } from '../src/terrain/height.js';
import { buildingsAround, generateBuildings, insideBuilding } from '../src/terrain/buildings.js';
import { generateRocks } from '../src/terrain/rocks.js';
import { generatePlants } from '../src/terrain/vegetation.js';
import { KERB, WATER_LEVEL } from '../src/terrain/town.js';
import { buildingsMeshData } from '../src/render/building-mesh.js';
import { rocksMeshData } from '../src/render/rock-mesh.js';

const town = createHeightField({ mode: 'town' });

describe('isometric town', () => {
  it('starts on a street that lies level from side to side, the same on every load', () => {
    expect(town.world).toBe('town');
    expect(town.roadDistance(0, 0)).toBeLessThan(0.01);
    expect(createHeightField({ mode: 'town' })(123.4, -56.7)).toBe(town(123.4, -56.7));
    let x = 0;
    let z = 0;
    let lo = Infinity;
    let hi = -Infinity;
    let prev = town.roadHeading(0, 0);
    for (let i = 0; i < 1000; i++) {
      // Along the street the way we were going, back onto its centre line.
      let yaw = town.roadHeading(x, z);
      if (Math.cos(yaw - prev) < 0) yaw += Math.PI;
      prev = yaw;
      const s = town.sample(x, z);
      x -= s.gx * s.side;
      z -= s.gz * s.side;
      const side = (off) => town(x + Math.sin(yaw) * off, z + Math.cos(yaw) * off);
      // Both wheel tracks level, away from junctions (where two gradings meet).
      if (town.sample(x, z).other > 25) expect(Math.abs(side(1.1) - side(-1.1))).toBeLessThan(0.06);
      const h = town(x, z);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
      // Streets keep above the water, also where they cross the river.
      expect(h).toBeGreaterThan(WATER_LEVEL + 0.3);
      x += Math.cos(yaw) * 2;
      z -= Math.sin(yaw) * 2;
    }
    expect(hi - lo).toBeGreaterThan(2);
  });

  it('has water, mountains and town districts', () => {
    let wet = 0;
    let peaks = 0;
    let townish = 0;
    let n = 0;
    for (let x = -1200; x <= 1200; x += 12) {
      for (let z = -1200; z <= 1200; z += 12) {
        const s = town.sample(x, z);
        n++;
        if (s.h < WATER_LEVEL - 0.3) wet++;
        if (s.h > 25) peaks++;
        if (s.wild < 0.2) townish++;
      }
    }
    expect(wet / n).toBeGreaterThan(0.01);
    expect(peaks / n).toBeGreaterThan(0.01);
    expect(townish / n).toBeGreaterThan(0.3);
  });

  it('lines the streets with buildings that keep off the sidewalks and each other', () => {
    const all = [];
    for (let cx = -3; cx <= 3; cx++) for (let cz = -3; cz <= 3; cz++) all.push(...generateBuildings(town, cx, cz));
    expect(all.length).toBeGreaterThan(80);
    for (const rock of all) {
      const b = rock.building;
      expect(rock.vertices.length).toBe(24);
      expect(rock.faces).toEqual([]);
      for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const x = b.x + b.ux * a * b.w * 0.5 + b.nx * c * b.d * 0.5;
        const z = b.z + b.uz * a * b.w * 0.5 + b.nz * c * b.d * 0.5;
        expect(town.roadDistance(x, z)).toBeGreaterThan(KERB);
      }
    }
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i].building;
        const b = all[j].building;
        // Apart along one of the four edge directions (separating axis).
        const apart = [[a.ux, a.uz], [a.nx, a.nz], [b.ux, b.uz], [b.nx, b.nz]].some(([ax, az]) => {
          const reach = (r) => (Math.abs(r.ux * ax + r.uz * az) * r.w + Math.abs(r.nx * ax + r.nz * az) * r.d) / 2;
          return Math.abs((b.x - a.x) * ax + (b.z - a.z) * az) > reach(a) + reach(b);
        });
        expect(apart).toBe(true);
      }
    }
    // A mix of roofs and heights.
    const roofs = new Set(all.map((r) => r.building.roof));
    expect(roofs.size).toBeGreaterThanOrEqual(3);
    expect(Math.max(...all.map((r) => r.building.storeys))).toBeGreaterThan(6);
  });

  it('gives buildings to the rocks (solid) and draws them apart from the rocks', () => {
    const rocks = generateRocks(town, 0, 0);
    const buildings = rocks.filter((r) => r.building);
    expect(buildings.length).toBeGreaterThan(0);
    expect(buildings).toEqual(generateBuildings(town, 0, 0));
    const mesh = buildingsMeshData(rocks);
    expect(mesh.positions.length).toBe(mesh.facade.length);
    expect(mesh.positions.length / 9).toBeGreaterThan(buildings.length * 12);
    const rockMesh = rocksMeshData(rocks);
    const natural = rocks.filter((r) => !r.building).reduce((n, r) => n + r.faces.length, 0);
    expect(rockMesh ? rockMesh.positions.length / 9 : 0).toBe(natural);
  });

  it('grows trees and shrubs outside the buildings and off the streets', () => {
    let trees = 0;
    for (let cx = -2; cx <= 2; cx++) {
      for (let cz = -2; cz <= 2; cz++) {
        const buildings = buildingsAround(town, cx, cz);
        for (const p of generatePlants(town, cx, cz)) {
          expect(town.roadDistance(p.x, p.z)).toBeGreaterThan(KERB);
          expect(insideBuilding(buildings, p.x, p.z)).toBe(false);
          if (p.kind === 'tree') trees++;
        }
      }
    }
    expect(trees).toBeGreaterThan(50);
  });
});
