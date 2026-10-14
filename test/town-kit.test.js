import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createHeightField } from '../src/terrain/height.js';
import { buildingsAround, generateBuildings, insideBuilding } from '../src/terrain/buildings.js';
import { generatePlants } from '../src/terrain/vegetation.js';
import { generateProps } from '../src/terrain/props.js';
import { funPlaces } from '../src/terrain/fun.js';
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

// The corners of every triangle that reaches into the band a car could hit (0.3 m to 2 m above
// the ground: not paving).
function filterLow(p) {
  const out = [];
  const y = (v) => p.positions[v * 3 + 1];
  for (let t = 0; t < p.index.length; t += 3) {
    const tri = [p.index[t], p.index[t + 1], p.index[t + 2]];
    const ys = tri.map(y);
    if (Math.min(...ys) < 2 && Math.max(...ys) > 0.3) for (const v of tri) out.push(p.positions[v * 3], p.positions[v * 3 + 1], p.positions[v * 3 + 2]);
  }
  return out;
}

describe('sunny town', () => {
  it('has side streets between its north-south streets, but not through the stunt parks', () => {
    const count = (fx, fz) => {
      let n = 0;
      let on = false;
      for (let t = -600; t < 600; t += 1) {
        const now = town.roadDistance(fx(t), fz(t)) < 1;
        if (now && !on) n++;
        on = now;
      }
      return n;
    };
    // Walking east crosses the north-south streets (60 m apart), walking south the east-west
    // ones (100 m apart).
    expect(count((t) => t, () => 23)).toBeGreaterThan(count(() => 41, (t) => t) * 1.4);
    // The side street would run right through a park's middle: there is none there.
    const finder = funPlaces(town, 0, 0, 500);
    let places = null;
    while (!places) places = finder.step(50);
    const parks = places.filter((p) => p.kind === 'park');
    expect(parks.length).toBeGreaterThan(1);
    for (const p of parks) expect(town.roadDistance(p.x, p.z)).toBeGreaterThan(20);
  });

  it('has jumps on its streets, clear of the junctions', () => {
    let jumps = 0;
    for (let x = -300; x < 300; x += 1.5) {
      for (let z = -300; z < 300; z += 1.5) {
        const s = town.sample(x, z);
        if (s.jump < 0.05) continue;
        expect(s.dist).toBeLessThan(KERB + 0.4);
        expect(s.other).toBeGreaterThan(17);
        if (s.jump > 1.3 && s.dist < 1) jumps++;
      }
    }
    expect(jumps).toBeGreaterThan(10);
  });

  it('has stunt parks: ramps and a bowl above the water, no buildings or plants in them', () => {
    let inPark = 0;
    let high = 0;
    for (let x = -500; x < 500; x += 2) {
      for (let z = -500; z < 500; z += 2) {
        const s = town.sample(x, z);
        if (s.park < 0.99 || s.dist < KERB + 1.5) continue;
        inPark++;
        expect(s.h).toBeGreaterThan(0.5);
        if (s.parkLift > 3) high++;
      }
    }
    expect(inPark).toBeGreaterThan(2000);
    expect(high).toBeGreaterThan(100);
    const all = [];
    for (let cx = -6; cx <= 6; cx++) for (let cz = -6; cz <= 6; cz++) all.push(...generateBuildings(town, cx, cz));
    for (const { building: b } of all) expect(town.sample(b.x, b.z).park).toBeLessThan(0.05);
    for (let cx = -3; cx <= 3; cx++) for (let cz = -3; cz <= 3; cz++) for (const p of generatePlants(town, cx, cz)) expect(town.sample(p.x, p.z).park).toBeLessThan(0.06);
  });

  it('jumps some streets over the river, with a kicker on one bank', () => {
    let lips = 0;
    for (let x = -700; x < 700; x += 1.5) {
      for (let z = -700; z < 700; z += 1.5) {
        const s = town.sample(x, z);
        const out = s.riverDist - s.riverHalf;
        // A lip: the road high right at the water's edge (no embankment there).
        if (s.dist < 1 && out > 0.6 && out < 2 && s.h > 3) lips++;
      }
    }
    expect(lips).toBeGreaterThan(5);
  });

  it('ramps driveways up onto some raised blocks, and builds nothing across them', () => {
    let ramps = 0;
    for (let x = -300; x < 300; x += 2) for (let z = -300; z < 300; z += 2) if (town.sample(x, z).driveway > 0.95) ramps++;
    expect(ramps).toBeGreaterThan(200);
    const all = [];
    for (let cx = -4; cx <= 4; cx++) for (let cz = -4; cz <= 4; cz++) all.push(...generateBuildings(town, cx, cz));
    for (const { building: b } of all) expect(town.sample(b.x, b.z).driveway).toBeLessThan(0.05);
  });

  it('scatters crates and cones the same way every time', () => {
    const props = [];
    for (let cx = -4; cx <= 4; cx++) for (let cz = -4; cz <= 4; cz++) props.push(...generateProps(town, cx, cz));
    expect(props.filter((p) => p.kind === 'cone').length).toBeGreaterThan(30);
    expect(props.filter((p) => p.kind === 'crate').length).toBeGreaterThan(6);
    for (const p of props) expect(Math.abs(p.y - town(p.x, p.z))).toBeLessThan(3.1); // stacked at most two crates up
    const fresh = createHeightField({ mode: 'daytown' });
    expect(generateProps(fresh, 1, -1)).toEqual(generateProps(town, 1, -1));
    expect(generateProps(createHeightField({ mode: 'town' }), 0, 0)).toEqual([]);
  });

  it('lists its fun places for the minimap', () => {
    const finder = funPlaces(town, 0, 0, 280);
    let places = null;
    for (let i = 0; i < 1000 && !places; i++) places = finder.step(5);
    const kinds = new Set(places.map((p) => p.kind));
    expect([...kinds].sort()).toEqual(['gap', 'jump', 'park']);
    for (const p of places) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(280);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(280);
      const s = town.sample(p.x, p.z);
      if (p.kind === 'park') expect(s.park).toBeGreaterThan(0.9);
      if (p.kind === 'jump') expect(s.jump).toBeGreaterThan(0.8);
      if (p.kind === 'gap') expect(s.gapLift).toBeGreaterThan(2.4);
    }
    expect(funPlaces(createHeightField({ mode: 'town' }), 0, 0, 280).step()).toEqual([]);
  });

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
    // A denser street grid than the dark town's: more streets crossed along a line.
    const dark = createHeightField({ mode: 'town' });
    expect(dark.buildingKit).toBe(false);
    const crossings = (field) => {
      let n = 0;
      let on = false;
      for (let z = -600; z < 600; z += 1) {
        const now = field.roadDistance(37, z) < 1;
        if (now && !on) n++;
        on = now;
      }
      return n;
    };
    expect(crossings(town)).toBeGreaterThan(crossings(dark) * 1.3);
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
    for (const k of TOWN_KIT) if (k.size !== 'rare' && k.size !== 'landmark') expect(used.has(k.name)).toBe(true);
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
      // (The fountain's plaza paving spreads further, kept clear of buildings by the town.)
      const spread = entry.name === 'Kit_Fountain' ? 10 : 2.5;
      expect(hi[0] - lo[0]).toBeLessThan(entry.w + spread);
      expect(hi[2] - lo[2]).toBeLessThan(entry.d + spread);
      // Walls reach well below the ground (for slopes); the roof's top as listed.
      expect(lo[1]).toBeLessThan(-4);
      expect(hi[1]).toBeCloseTo(entry.top, 1);
      expect(p.index.length / 3).toBeLessThan(4000);
      if (entry.name !== 'Kit_LatticeTower') expect(p.glass.some((g) => g === 1)).toBe(true);
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
