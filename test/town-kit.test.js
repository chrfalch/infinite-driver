import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createHeightField } from '../src/terrain/height.js';
import { buildingsAround, generateBuildings, insideBuilding } from '../src/terrain/buildings.js';
import { KERB } from '../src/terrain/town.js';
import { TOWN_KIT } from '../src/terrain/town-kit.js';
import { buildingsMeshData } from '../src/render/building-mesh.js';
import { createKitBuildingsMesh, prototypesFrom } from '../src/render/town-kit-mesh.js';

const town = createHeightField({ mode: 'daytown' });

async function loadKit() {
  const glb = readFileSync(new URL('../public/models/town-kit.glb', import.meta.url));
  const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  return prototypesFrom(gltf.scene);
}

function bounds(p) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], p.positions[i + a]);
      hi[a] = Math.max(hi[a], p.positions[i + a]);
    }
  }
  return { lo, hi };
}

// The corners of every triangle that reaches into the band a car could hit (0.5 m below the
// ground to 2 m above it).
function filterLow(p) {
  const out = [];
  const y = (v) => p.positions[v * 3 + 1];
  for (let t = 0; t < p.index.length; t += 3) {
    const tri = [p.index[t], p.index[t + 1], p.index[t + 2]];
    const ys = tri.map(y);
    if (Math.min(...ys) < 2 && Math.max(...ys) > -0.5) for (const v of tri) out.push(p.positions[v * 3], p.positions[v * 3 + 1], p.positions[v * 3 + 2]);
  }
  return out;
}

describe('sunny town', () => {
  it('lines its streets with rows of buildings', () => {
    // Points just behind the sidewalks in town, away from junctions and the water: most are
    // inside a building.
    let n = 0;
    let built = 0;
    for (let x = -240; x < 240; x += 2) {
      for (let z = -240; z < 240; z += 2) {
        const s = town.sample(x, z);
        if (s.wild > 0.2 || s.dist < KERB + 1.5 || s.dist > KERB + 2.5 || s.townHill > 0.5 || s.riverDist < s.riverHalf + 12 || s.mountain > 1 || s.other < 14) continue;
        n++;
        if (insideBuilding(buildingsAround(town, Math.floor(x / 64), Math.floor(z / 64)), x, z, 0.5)) built++;
      }
    }
    expect(n).toBeGreaterThan(200);
    expect(built / n).toBeGreaterThan(0.45);
  });

  it('is the town by day, built from the kit', () => {
    expect(town.world).toBe('daytown');
    expect(town.town).toBe(true);
    expect(town.buildingKit).toBe(true);
    // Same streets as the dark town.
    const dark = createHeightField({ mode: 'town' });
    expect(town(123.4, -56.7)).toBe(dark(123.4, -56.7));
    expect(dark.buildingKit).toBe(false);
  });

  it('puts kit buildings at their models\' size on the lots, off the sidewalks', () => {
    const all = [];
    for (let cx = -3; cx <= 3; cx++) for (let cz = -3; cz <= 3; cz++) all.push(...generateBuildings(town, cx, cz));
    expect(all.length).toBeGreaterThan(60);
    const used = new Set();
    for (const { building: b } of all) {
      const kit = TOWN_KIT.find((k) => k.name === b.kit);
      expect(kit).toBeDefined();
      used.add(kit.name);
      expect(b.roof).toBe('kit');
      // At the model's size; straight-fronted ones may be stretched a little along the street.
      expect([b.d, b.height]).toEqual([kit.d, kit.eaves]);
      expect(b.w).toBeCloseTo(kit.w * b.stretch, 6);
      if (kit.stretch) expect(b.stretch).toBeGreaterThanOrEqual(0.85);
      else expect(b.stretch).toBe(1);
      expect(b.stretch).toBeLessThanOrEqual(1.15);
      for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const x = b.x + b.ux * a * b.w * 0.5 + b.nx * c * b.d * 0.5;
        const z = b.z + b.uz * a * b.w * 0.5 + b.nz * c * b.d * 0.5;
        expect(town.roadDistance(x, z)).toBeGreaterThan(KERB);
      }
    }
    // Every everyday model shows up (the landmarks are rare).
    for (const k of TOWN_KIT) if (k.size !== 'rare') expect(used.has(k.name)).toBe(true);
    // None overlap (separating axis on the four edge directions).
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i].building;
        const b = all[j].building;
        const apart = [[a.ux, a.uz], [a.nx, a.nz], [b.ux, b.uz], [b.nx, b.nz]].some(([ax, az]) => {
          const reach = (r) => (Math.abs(r.ux * ax + r.uz * az) * r.w + Math.abs(r.nx * ax + r.nz * az) * r.d) / 2;
          return Math.abs((b.x - a.x) * ax + (b.z - a.z) * az) > reach(a) + reach(b);
        });
        expect(apart).toBe(true);
      }
    }
    // Every chunk agrees on the buildings standing in it, however it is reached (the rows and
    // lots are cached; a fresh field builds the same).
    const again = [];
    const fresh = createHeightField({ mode: 'daytown' });
    for (let cx = 3; cx >= -3; cx--) for (let cz = 3; cz >= -3; cz--) again.push(...generateBuildings(fresh, cx, cz));
    expect(again.length).toBe(all.length);
    // None of them are drawn as the dark town's boxes.
    expect(buildingsMeshData(all)).toBeNull();
  });

  it('has a model for every kit entry, matching its footprint, within the triangle budget', async () => {
    const kit = await loadKit();
    for (const entry of TOWN_KIT) {
      const p = kit.get(entry.name);
      const { lo, hi } = bounds(p);
      // The solid footprint near the ground (the physics box): x along the street (w), z away
      // from it (d), centred on the origin.
      const low = bounds({ positions: filterLow(p) });
      expect(low.hi[0] - low.lo[0]).toBeCloseTo(entry.w, 1);
      expect(low.hi[2] - low.lo[2]).toBeCloseTo(entry.d, 1);
      expect(Math.abs(low.hi[0] + low.lo[0])).toBeLessThan(0.02);
      expect(Math.abs(low.hi[2] + low.lo[2])).toBeLessThan(0.02);
      // Eaves, awnings and the roof reach out only a little past it.
      expect(hi[0] - lo[0]).toBeLessThan(entry.w + 2.5);
      expect(hi[2] - lo[2]).toBeLessThan(entry.d + 2.5);
      // Walls reach well below the ground (for slopes); the roof's top as listed.
      expect(lo[1]).toBeLessThan(-4);
      expect(hi[1]).toBeCloseTo(entry.top, 1);
      expect(p.index.length / 3).toBeLessThan(4000);
      expect(p.glass.some((g) => g === 1)).toBe(true);
      // Coloured (the baked colours made it into the model): walls, roofs and trim differ.
      expect(new Set(Array.from(p.colors, (c) => c.toFixed(2))).size).toBeGreaterThan(8);
      // The main walls (and roofs) are marked for repainting, and only they.
      const walls = p.paint.reduce((n, w) => n + (w === 1 ? 1 : 0), 0);
      if (entry.paint !== 'none') expect(walls).toBeGreaterThan(20);
      expect(walls).toBeLessThan(p.paint.length / 2);
      for (let i = 0; i < p.normals.length; i += 3) expect(Math.hypot(p.normals[i], p.normals[i + 1], p.normals[i + 2])).toBeCloseTo(1, 2);
    }
  });

  it('turns each building to face its street', async () => {
    const kit = await loadKit();
    const rocks = generateBuildings(town, 0, 0);
    expect(rocks.length).toBeGreaterThan(0);
    const mesh = createKitBuildingsMesh(rocks, kit);
    expect(mesh.geometry.index.count).toBe(rocks.reduce((n, r) => n + kit.get(r.building.kit).index.length, 0));
    // The first building's front door is on its street side: its model's front-most vertices
    // (largest z) end up nearest the street.
    const b = rocks[0].building;
    const p = kit.get(b.kit);
    const pos = mesh.geometry.attributes.position;
    let front = 0;
    for (let i = 1; i < p.glass.length; i++) if (p.positions[i * 3 + 2] > p.positions[front * 3 + 2]) front = i;
    let back = 0;
    for (let i = 1; i < p.glass.length; i++) if (p.positions[i * 3 + 2] < p.positions[back * 3 + 2]) back = i;
    const dist = (i) => town.roadDistance(pos.getX(i), pos.getZ(i));
    expect(dist(front)).toBeLessThan(dist(back));
    expect(pos.getY(front)).toBeCloseTo(b.ground + p.positions[front * 3 + 1], 4);
  });
});
