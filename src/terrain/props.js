// The sunny town's loose props: wooden crates and traffic cones that the car can send flying.
// Crates stand in stacks on the stunt parks' landing zones and in the parks' corners, cones in a
// slalom through each park and in pairs at the foot of the street jumps. Every chunk's props come
// from its position alone, so the main thread (drawing) and the physics worker (bodies) agree.
//
// A prop: { kind: 'crate' | 'cone', x, y, z, yaw } with y its base on the ground (a crate stacked
// on others stands on them).
import { CHUNK_SIZE } from './chunk.js';
import { ROAD_HALF_WIDTH, JUMP_SPACING, streetJumpAt } from './town.js';
import { crossing, streetPoint } from './buildings.js';

export const CRATE = 1.0; // m, a crate's side
export const CONE = { radius: 0.22, height: 0.72 };

// Spots in a stunt park (m from its middle, along the two street families' fields, as
// town.js's parkHeight): crate pyramids beyond the kickers' landings, cone slaloms beside the
// tabletop, crate stacks by the banks.
const PARK_PYRAMIDS = [[0, 40], [0, -40]];
const PARK_STACKS = [[28, 32], [-28, -32], [30, -30], [-30, 30]];
const PARK_CONES = [];
for (const px of [-10.5, 10.5]) for (let pz = -16; pz <= 16; pz += 5.3) PARK_CONES.push([px, pz]);

function hash(a, b, c) {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const cache = new Map();

export function generateProps(heightAt, cx, cz) {
  if (!heightAt.buildingKit) return [];
  const key = `${cx},${cz}`;
  const hit = cache.get(key);
  if (hit && hit.heightAt === heightAt) return hit.props;
  const props = [];
  const x0 = cx * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;
  const inChunk = (x, z) => x >= x0 && x < x0 + CHUNK_SIZE && z >= z0 && z < z0 + CHUNK_SIZE;
  const [f0, f1] = heightAt.streetFamilies;
  const corners = [[x0, z0], [x0 + CHUNK_SIZE, z0], [x0, z0 + CHUNK_SIZE], [x0 + CHUNK_SIZE, z0 + CHUNK_SIZE]];
  const range = (f, spacing, pad) => {
    const a = corners.map(([x, z]) => f.across(x, z));
    return [Math.floor((Math.min(...a) - pad) / spacing), Math.floor((Math.max(...a) + pad) / spacing)];
  };

  // Stunt parks reaching into this chunk.
  const { sizeX, sizeZ, isPark } = heightAt.blocks;
  const [i0, i1] = range(f0, sizeX, 60);
  const [j0, j1] = range(f1, sizeZ, 60);
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      if (!isPark(i, j)) continue;
      const c0 = (i + 0.5) * sizeX;
      const c1 = (j + 0.5) * sizeZ;
      const centre = crossing(heightAt, c0, c1);
      if (!centre) continue;
      const at = (px, pz) => crossing(heightAt, c0 + px, c1 + pz, centre.x, centre.z);
      const onPark = (p) => p && inChunk(p.x, p.z) && heightAt.sample(p.x, p.z).park > 0.95;
      const r = (q) => hash(i * 7 + 3, j * 13 + 5, q);
      PARK_PYRAMIDS.forEach(([px, pz], n) => {
        const p = at(px, pz);
        if (!onPark(p)) return;
        const y = heightAt(p.x, p.z);
        const yaw = r(n) * 0.3;
        // Three, two and one crates high.
        for (let row = 0; row < 3; row++) {
          for (let c = 0; c < 3 - row; c++) {
            const s = (c - (2 - row) / 2) * (CRATE + 0.02);
            props.push({ kind: 'crate', x: p.x + Math.cos(yaw) * s, y: y + row * CRATE, z: p.z - Math.sin(yaw) * s, yaw });
          }
        }
      });
      PARK_STACKS.forEach(([px, pz], n) => {
        const p = at(px, pz);
        if (!onPark(p)) return;
        const y = heightAt(p.x, p.z);
        const yaw = r(20 + n) * Math.PI;
        props.push({ kind: 'crate', x: p.x, y, z: p.z, yaw }, { kind: 'crate', x: p.x, y: y + CRATE, z: p.z, yaw: yaw + 0.4 });
      });
      for (const [px, pz] of PARK_CONES) {
        const p = at(px, pz);
        if (onPark(p)) props.push({ kind: 'cone', x: p.x, y: heightAt(p.x, p.z), z: p.z, yaw: 0 });
      }
    }
  }

  // Cones in pairs at both ends of the street jumps, at the edges of the road.
  heightAt.streetFamilies.forEach((f, fi) => {
    const [k0, k1] = range(f, f.spacing, 10).map((k, n) => k + n);
    const ts = corners.map(([x, z]) => (f.alongX ? x : z));
    const m0 = Math.floor((Math.min(...ts) - 40) / JUMP_SPACING);
    const m1 = Math.floor((Math.max(...ts) + 40) / JUMP_SPACING);
    for (let k = k0; k <= k1; k++) {
      for (let m = m0; m <= m1; m++) {
        const jump = streetJumpAt(fi, k, m);
        if (!jump) continue;
        const mid = streetPoint(f, k, jump.t0);
        // Only where the jump is really there (not damped near a junction, the river or the wild).
        if (!mid || heightAt.sample(mid.x, mid.z).jump < 0.8) continue;
        for (const end of [-1, 1]) {
          const p = streetPoint(f, k, jump.t0 + end * (jump.reach + 1.5));
          if (!p) continue;
          for (const side of [-1, 1]) {
            const x = p.x + p.gx * side * (ROAD_HALF_WIDTH - 0.5);
            const z = p.z + p.gz * side * (ROAD_HALF_WIDTH - 0.5);
            if (inChunk(x, z)) props.push({ kind: 'cone', x, y: heightAt(x, z), z, yaw: 0 });
          }
        }
      }
    }
  });

  cache.set(key, { heightAt, props });
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return props;
}
