import { createNoise3D } from 'simplex-noise';
import { mulberry32 } from './height.js';
import { CHUNK_SIZE } from './chunk.js';
import { BED_HALF_WIDTH, ROCK_EDGE, ROCK_REACH } from './riverbed.js';

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
export function makeRock(heightAt, x, z, size, rand, noise) {
  const sx = size * (0.8 + rand() * 0.5);
  const sy = size * (0.45 + rand() * 0.35);
  const sz = size * (0.8 + rand() * 0.5);
  const yaw = rand() * Math.PI * 2;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const sink = sy * (0.25 + rand() * 0.2);
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
  // The snowfield is open snow for now.
  if (heightAt.world === 'snow') return [];
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

// The lowest of the rock sheet under a loose rock's footprint, so it rests in the sheet instead of
// floating off a slope.
function restingGround(heightAt, radius) {
  return (x, z) => Math.min(heightAt(x, z), heightAt(x + radius, z), heightAt(x - radius, z), heightAt(x, z + radius), heightAt(x, z - radius));
}

// Dry river: the bed and its walls are one rock sheet in the ground itself (terrain/riverbed.js).
// Loose on top of it lie smaller rocks (15-50 cm, solid like any rock), and a few bigger ones in
// the forest beyond. Yellow-grey sandstone.
function generateRiverRocks(heightAt, cx, cz, { seed, count }) {
  const rand = mulberry32(hashChunk(seed, cx, cz));
  const noise = createNoise3D(rand);
  const rocks = [];
  // About one per 6 m² of the bed, fewer up on the walls; none near the spawn point.
  const bedRand = mulberry32(hashChunk(seed + 7, cx, cz));
  for (let k = 0; k < 700; k++) {
    const x = (cx + bedRand()) * CHUNK_SIZE;
    const z = (cz + bedRand()) * CHUNK_SIZE;
    const keep = bedRand();
    const size = 0.15 + 0.35 * bedRand() * bedRand();
    const dist = heightAt.roadDistance(x, z);
    if (dist > ROCK_EDGE - 0.5 || keep > (dist < BED_HALF_WIDTH + 0.5 ? 0.9 : 0.35)) continue;
    if (Math.hypot(x, z) < 3.5) continue;
    const rock = makeRock(restingGround(heightAt, size * 0.4), x, z, size, bedRand, noise);
    rock.sand = true;
    rocks.push(rock);
  }
  for (let k = 0; k < count; k++) {
    const x = (cx + rand()) * CHUNK_SIZE;
    const z = (cz + rand()) * CHUNK_SIZE;
    const keep = rand();
    const size = 0.3 + rand() * rand() * 1.2;
    const dist = heightAt.roadDistance(x, z);
    if (dist < ROCK_REACH + 1.5 || keep > (dist < 30 ? 0.15 : 0.05)) continue;
    if (Math.abs(heightAt(x + 1, z) - heightAt(x - 1, z)) + Math.abs(heightAt(x, z + 1) - heightAt(x, z - 1)) > 1.2) continue;
    const rock = makeRock(heightAt, x, z, size, rand, noise);
    rock.sand = true;
    rocks.push(rock);
  }
  return rocks;
}

// Dry river: pebbles (5-17 cm across, like the stones the tyres throw) scattered over the rock
// sheet, gathered in its creases. Drawn only (render/pebble-mesh.js); the tyres roll through them.
// Per pebble: x, y, z, yaw, size, squash (height / width), tint, grey.
export const PEBBLE_STRIDE = 8;
export function generatePebbles(heightAt, cx, cz, { seed = 99 } = {}) {
  if (heightAt.world !== 'river') return null;
  const rand = mulberry32(hashChunk(seed + 13, cx, cz));
  const out = [];
  for (let k = 0; k < 12000; k++) {
    const x = (cx + rand()) * CHUNK_SIZE;
    const z = (cz + rand()) * CHUNK_SIZE;
    const keep = rand();
    const size = 0.025 + 0.06 * rand() * rand(); // radius
    if (keep > 0.8 || heightAt.roadDistance(x, z) > ROCK_EDGE) continue;
    // More in the creases (the sheet is lower than around it), few on the humps.
    const h = heightAt(x, z);
    const around = (heightAt(x + 0.3, z) + heightAt(x - 0.3, z) + heightAt(x, z + 0.3) + heightAt(x, z - 0.3)) / 4 - h;
    if (keep > 0.2 + Math.min(0.6, Math.max(0, around * 8))) continue;
    out.push(x, h - size * 0.15, z, rand() * 6.2832, size, 0.5 + 0.3 * rand(), rand(), rand());
  }
  return out.length ? new Float32Array(out) : null;
}
