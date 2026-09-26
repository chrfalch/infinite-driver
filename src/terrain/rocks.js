import { createNoise3D } from 'simplex-noise';
import { mulberry32 } from './height.js';
import { CHUNK_SIZE } from './chunk.js';

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

// Deterministic rocks for one chunk. Each rock has a world transform baked into its vertices.
export function generateRocks(heightAt, cx, cz, { seed = 99, count = 70 } = {}) {
  const rand = mulberry32(hashChunk(seed, cx, cz));
  const noise = createNoise3D(rand);
  const rocks = [];
  for (let n = 0; n < count; n++) {
    const x = (cx + rand()) * CHUNK_SIZE;
    const z = (cz + rand()) * CHUNK_SIZE;
    const size = pickSize(rand());
    if (Math.hypot(x, z) < SPAWN_CLEAR_RADIUS + size) continue;

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
    rocks.push({ x, z, size, vertices, faces: BASE.faces, tint: rand() });
  }
  return rocks;
}
