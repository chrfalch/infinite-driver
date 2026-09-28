import { createNoise3D } from 'simplex-noise';
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
// `bury`: extra share of its height sunk into the ground; `squash`: height scale (flatter rocks).
export function makeRock(heightAt, x, z, size, rand, noise, { bury = 0, squash = 1 } = {}) {
  const sx = size * (0.8 + rand() * 0.5);
  const sy = size * (0.45 + rand() * 0.35) * squash;
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

// Dry river: the bed is floored with big boulders (as big as the walls', 2-3.5 m across), sunk
// deep and overlapping so their broad tops join into one uneven rock surface, and walled in by two
// staggered rows of tall, steep boulders along each bank (1-2 m high) that the car cannot climb. A few
// rocks lie in the forest beyond. Yellow-grey sandstone. Bed rocks are flagged `bed`: respawn drops
// the car onto them rather than looking for a clear spot.
const BED_CELL = 1.9; // m, jittered grid of bed boulders
const WALL_CELL = 1.5; // m between boulders along a wall row
const WALL_ROWS = [BED_HALF_WIDTH + 1.9, BED_HALF_WIDTH + 3.5]; // m from the bed centre line

// Moves (x, z) across the bed onto the line `target` metres from its centre (two Newton steps on
// the distance field), or returns null if it is not near that line.
function ontoRow(heightAt, x, z, target, reach) {
  for (let k = 0; k < 2; k++) {
    const d = heightAt.roadDistance(x, z);
    if (k === 0 && Math.abs(d - target) > reach) return null;
    const e = 0.3;
    const gx = (heightAt.roadDistance(x + e, z) - heightAt.roadDistance(x - e, z)) / (2 * e);
    const gz = (heightAt.roadDistance(x, z + e) - heightAt.roadDistance(x, z - e)) / (2 * e);
    const g = Math.hypot(gx, gz) || 1;
    x -= (gx / g) * (d - target);
    z -= (gz / g) * (d - target);
  }
  return { x, z };
}

function generateRiverRocks(heightAt, cx, cz, { seed, count }) {
  const rand = mulberry32(hashChunk(seed, cx, cz));
  const noise = createNoise3D(rand);
  const rocks = [];
  const x0 = cx * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;
  const inChunk = (x, z) => x >= x0 && x < x0 + CHUNK_SIZE && z >= z0 && z < z0 + CHUNK_SIZE;
  // The bed floor.
  const n = CHUNK_SIZE / BED_CELL;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + (i + 0.2 + rand() * 0.6) * BED_CELL;
      const z = z0 + (j + 0.2 + rand() * 0.6) * BED_CELL;
      const sizeRoll = rand();
      const buryRoll = rand();
      const dist = heightAt.roadDistance(x, z);
      if (dist > BED_HALF_WIDTH + 0.8) continue;
      if (Math.hypot(x, z) < 5) continue; // a small sandy patch where the car first starts
      const size = 0.95 + sizeRoll * 0.4;
      // Flattened and sunk deep: broad, gently domed tops that stand 15-45 cm proud of the sand.
      const rock = makeRock(heightAt, x, z, size, rand, noise, { bury: 0.35 + buryRoll * 0.3, squash: 0.6 });
      rock.sand = true;
      rock.bed = true;
      rocks.push(rock);
    }
  }
  // Boulder walls: each row's candidates come from its own grid, moved onto the row line. The
  // second row's grid is offset half a cell, so its boulders sit in the gaps of the first.
  WALL_ROWS.forEach((row, r) => {
    const off = r * WALL_CELL * 0.5;
    const m = Math.ceil(CHUNK_SIZE / WALL_CELL) + 1;
    for (let j = -1; j < m; j++) {
      for (let i = -1; i < m; i++) {
        const gx = x0 + off + (i + 0.5) * WALL_CELL;
        const gz = z0 + off + (j + 0.5) * WALL_CELL;
        const sizeRoll = rand();
        const p = ontoRow(heightAt, gx, gz, row, WALL_CELL * 0.5);
        if (!p || !inChunk(p.x, p.z)) continue;
        // Tall, steep-sided boulders: a tyre meets a face it cannot climb, so the car bumps off
        // instead of riding up and beaching on them.
        const rock = makeRock(heightAt, p.x, p.z, 0.95 + sizeRoll * 0.35, rand, noise, { squash: 1.5 });
        rock.sand = true;
        rock.wall = true;
        rocks.push(rock);
      }
    }
  });
  // A few rocks in the forest.
  for (let k = 0; k < count; k++) {
    const x = x0 + rand() * CHUNK_SIZE;
    const z = z0 + rand() * CHUNK_SIZE;
    const keep = rand();
    const size = 0.3 + rand() * rand() * 1.2;
    const dist = heightAt.roadDistance(x, z);
    if (dist < WALL_ROWS[1] + 2 || keep > (dist < 30 ? 0.15 : 0.05)) continue;
    if (Math.abs(heightAt(x + 1, z) - heightAt(x - 1, z)) + Math.abs(heightAt(x, z + 1) - heightAt(x, z - 1)) > 1.2) continue;
    const rock = makeRock(heightAt, x, z, size, rand, noise);
    rock.sand = true;
    rocks.push(rock);
  }
  return rocks;
}
