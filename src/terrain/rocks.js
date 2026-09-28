import { createNoise2D, createNoise3D } from 'simplex-noise';
import { mulberry32 } from './height.js';
import { CHUNK_SIZE } from './chunk.js';
import { BED_HALF_WIDTH } from './riverbed.js';

const SPAWN_CLEAR_RADIUS = 10;

// Unit icosphere (subdivision 1), built by hand so this module stays renderer-free.
function icosphere() {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => normalize(v));
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const cache = new Map();
  const mid = (a, b) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (!cache.has(key)) {
      const [x1, y1, z1] = verts[a];
      const [x2, y2, z2] = verts[b];
      verts.push(normalize([(x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2]));
      cache.set(key, verts.length - 1);
    }
    return cache.get(key);
  };
  faces = faces.flatMap(([a, b, c]) => {
    const ab = mid(a, b);
    const bc = mid(b, c);
    const ca = mid(c, a);
    return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]];
  });
  return { verts, faces };
}

function normalize([x, y, z]) {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

const BASE = icosphere();

function hashChunk(seed, cx, cz) {
  let h = seed ^ Math.imul(cx, 0x27d4eb2d) ^ Math.imul(cz, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return (h ^ (h >>> 13)) >>> 0;
}

function pickSize(r) {
  if (r < 0.62) return 0.12 + r * 0.35; // pebbles you can roll over
  if (r < 0.9) return 0.35 + (r - 0.62) * 1.6; // small to medium rocks
  if (r < 0.985) return 0.8 + (r - 0.9) * 6; // big rocks
  return 1.6 + (r - 0.985) * 60; // rare boulders
}

// One rock with its world transform baked into its vertices.
export function makeRock(heightAt, x, z, size, rand, noise, bury = 0) {
  const sx = size * (0.8 + rand() * 0.5);
  const sy = size * (0.45 + rand() * 0.35);
  const sz = size * (0.8 + rand() * 0.5);
  const yaw = rand() * Math.PI * 2;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const sink = sy * (0.25 + rand() * 0.2 + bury);
  const ground = heightAt(x, z);
  const offset = rand() * 100;

  const vertices = new Float32Array(BASE.verts.length * 3);
  BASE.verts.forEach(([vx, vy, vz], i) => {
    const bump = 1 + noise(vx * 1.3 + offset, vy * 1.3, vz * 1.3) * 0.28;
    // Flatten the underside so rocks sit on the ground.
    const lx = vx * bump * sx;
    const ly = Math.max(vy * bump, -0.35) * sy;
    const lz = vz * bump * sz;
    vertices[i * 3] = x + lx * cos - lz * sin;
    vertices[i * 3 + 1] = ground + ly + sy * 0.35 - sink;
    vertices[i * 3 + 2] = z + lx * sin + lz * cos;
  });
  return { x, z, size, vertices, faces: BASE.faces, tint: rand() };
}

// Deterministic rocks for one chunk. Each rock has a world transform baked into its vertices.
export function generateRocks(heightAt, cx, cz, { seed = 99, count = 70 } = {}) {
  if (heightAt.world === 'river') return generateRiverRocks(heightAt, cx, cz, { seed, count });
  const rand = mulberry32(hashChunk(seed, cx, cz));
  const noise = createNoise3D(rand);
  const rocks = [];
  for (let n = 0; n < count; n++) {
    const x = (cx + rand()) * CHUNK_SIZE;
    const z = (cz + rand()) * CHUNK_SIZE;
    const size = pickSize(rand());
    if (Math.hypot(x, z) < SPAWN_CLEAR_RADIUS + size) continue;
    // Canyon: keep the roads clear and leave the cliffs bare; the rocks are red sandstone.
    if (heightAt.roadDistance && heightAt.roadDistance(x, z) < 5 + size) continue;
    if (heightAt.canyon && Math.abs(heightAt(x + 1, z) - heightAt(x - 1, z)) + Math.abs(heightAt(x, z + 1) - heightAt(x, z - 1)) > 1.6) continue;
    const rock = makeRock(heightAt, x, z, size, rand, noise);
    if (heightAt.canyon) rock.red = true;
    rocks.push(rock);
  }
  return rocks;
}

// Dry river: the bed is a rock garden of faceted rocks half buried in the sand, denser in some
// stretches than others, with cobbles along the bed edges and banks and a few rocks in the forest;
// yellow-grey sandstone. Bed rocks stand about 10-30 cm proud: the car has to slow down, but its
// tyres can climb them. They are flagged `bed` (respawn drops the car onto them rather than
// looking for a clear spot).
const bedDensity = createNoise2D(mulberry32(31337));
const BED_CELL = 1.0; // m, jittered grid of candidate bed rocks

function riverRockSize(r, boulders) {
  if (r < 0.7) return 0.2 + r * 0.35; // cobbles
  if (r < 0.95 || !boulders) return 0.45 + (r - 0.7) * 1.2; // small rocks
  return 0.75 + (r - 0.95) * 10; // an odd boulder on the banks
}

function generateRiverRocks(heightAt, cx, cz, { seed, count }) {
  const rand = mulberry32(hashChunk(seed, cx, cz));
  const noise = createNoise3D(rand);
  const rocks = [];
  const steep = (x, z) => Math.abs(heightAt(x + 1, z) - heightAt(x - 1, z)) + Math.abs(heightAt(x, z + 1) - heightAt(x, z - 1)) > 1.2;
  // Bed rocks.
  const n = CHUNK_SIZE / BED_CELL;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = cx * CHUNK_SIZE + (i + 0.1 + rand() * 0.8) * BED_CELL;
      const z = cz * CHUNK_SIZE + (j + 0.1 + rand() * 0.8) * BED_CELL;
      const keep = rand();
      const sizeRoll = rand();
      const buryRoll = rand();
      if (x >= (cx + 1) * CHUNK_SIZE || z >= (cz + 1) * CHUNK_SIZE) continue;
      const dist = heightAt.roadDistance(x, z);
      if (dist > BED_HALF_WIDTH + 0.6) continue;
      // Patchy: stretches of dense rock and of sparser, sandier going.
      const density = 0.68 + 0.25 * bedDensity(x * 0.025, z * 0.025);
      const edge = 1 - Math.max(0, Math.min(1, (dist - (BED_HALF_WIDTH - 0.8)) / 1.4));
      if (keep > density * edge) continue;
      const size = sizeRoll < 0.7 ? 0.28 + sizeRoll * 0.4 : sizeRoll < 0.95 ? 0.56 + (sizeRoll - 0.7) * 0.8 : 0.76 + (sizeRoll - 0.95) * 3;
      // The biggest rocks lie toward the bed edges; mid-bed they stay under about 45 cm tall.
      if (dist < 2.5 && size > 0.66) continue;
      if (Math.hypot(x, z) < 5 + size) continue;
      const rock = makeRock(heightAt, x, z, size, rand, noise, 0.2 + buryRoll * 0.25);
      rock.sand = true;
      rock.bed = true;
      rocks.push(rock);
    }
  }
  // Cobbles and rocks on the banks and in the forest.
  for (let k = 0; k < count * 3; k++) {
    const x = (cx + rand()) * CHUNK_SIZE;
    const z = (cz + rand()) * CHUNK_SIZE;
    const keep = rand();
    const sizeRoll = rand();
    const dist = heightAt.roadDistance(x, z);
    let p;
    let boulders = false;
    if (dist < BED_HALF_WIDTH + 0.6) continue;
    else if (dist < 6) p = 0.35;
    else if (dist < 10) [p, boulders] = [0.4, true];
    else if (dist < 30) [p, boulders] = [0.05, true];
    else p = 0.02;
    if (keep > p) continue;
    const size = riverRockSize(sizeRoll, boulders);
    if (Math.hypot(x, z) < SPAWN_CLEAR_RADIUS + size) continue;
    if (steep(x, z)) continue;
    const rock = makeRock(heightAt, x, z, size, rand, noise);
    rock.sand = true;
    rocks.push(rock);
  }
  return rocks;
}
