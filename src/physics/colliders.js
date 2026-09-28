// Terrain colliders for a physics world that has no terrain meshes (the physics worker). The same
// seeded functions as the main thread's terrain streaming (systems/terrain.js) give the same
// ground, rocks and tree trunks, so both threads agree on where everything is.
import { CHUNK_RES, CHUNK_SIZE, chunkKey, sampleChunk } from '../terrain/chunk.js';
import { generateRocks } from '../terrain/rocks.js';
import { ROCK_COLLIDER_BANDS, rockSheetTrimesh } from '../terrain/rock-sheet.js';
import { generatePlants } from '../terrain/vegetation.js';

let indices = null;
function chunkIndices(res = CHUNK_RES) {
  if (indices) return indices;
  const n = res + 1;
  indices = new Uint32Array(res * res * 6);
  let k = 0;
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const a = ix + iz * n;
      indices[k++] = a;
      indices[k++] = a + n;
      indices[k++] = a + 1;
      indices[k++] = a + 1;
      indices[k++] = a + n;
      indices[k++] = a + n + 1;
    }
  }
  return indices;
}

function chunkVertices(heights, cx, cz, size = CHUNK_SIZE, res = CHUNK_RES) {
  const n = res + 1;
  const step = size / res;
  const vertices = new Float32Array(n * n * 3);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = ix + iz * n;
      vertices[i * 3] = cx * size + ix * step;
      vertices[i * 3 + 1] = heights[i];
      vertices[i * 3 + 2] = cz * size + iz * step;
    }
  }
  return vertices;
}

// Streams chunk colliders around a point: the ground trimesh, rock hulls, and tree trunks for the
// chunks within `radius`, one job per call (like the main thread's streaming). Each chunk's rocks
// are kept as a RockField entity, for the GPU tyres' rock set.
const ROCK_BATCH = 150;

export function createColliderStreamer({ rapier, world: physicsWorld, ecs, RockField, heightAt, rockCount, radius = 1 }) {
  const chunks = new Map();

  function buildGround(c) {
    const heights = sampleChunk(heightAt, c.cx, c.cz);
    const desc = rapier.ColliderDesc.trimesh(chunkVertices(heights, c.cx, c.cz), chunkIndices()).setFriction(1.0);
    c.ground = physicsWorld.createCollider(desc);
  }

  // Rock hulls are built ROCK_BATCH at a time (the dry river has several hundred per chunk, a few
  // ms of hull building); the tree trunks come with the last batch. `all` builds everything now.
  function buildRocks(c, all = false) {
    if (!c.colliders) {
      c.colliders = [];
      c.nextRock = 0;
      c.entity = ecs.spawn(RockField({ rocks: c.rocks, colliders: c.colliders }));
    }
    const end = all ? c.rocks.length : Math.min(c.rocks.length, c.nextRock + ROCK_BATCH);
    for (; c.nextRock < end; c.nextRock++) {
      const desc = rapier.ColliderDesc.convexHull(c.rocks[c.nextRock].vertices);
      if (desc) c.colliders.push(physicsWorld.createCollider(desc.setFriction(1.3)));
    }
    if (c.nextRock < c.rocks.length) return;
    c.done = true;
    for (const p of generatePlants(heightAt, c.cx, c.cz)) {
      if (p.kind !== 'tree') continue;
      const r = p.trunk ?? 0.05 * p.height;
      const half = 0.3 * p.height;
      const desc = rapier.ColliderDesc.cylinder(half, r).setTranslation(p.x, p.y + half, p.z).setFriction(0.7);
      c.colliders.push(physicsWorld.createCollider(desc));
    }
  }

  // One band of the dry river's rock sheet (on top of the ground).
  function buildSheetBand(c) {
    const mesh = rockSheetTrimesh(heightAt, c.cx, c.cz, c.sheet.length);
    c.sheet.push(mesh ? physicsWorld.createCollider(rapier.ColliderDesc.trimesh(mesh.vertices, mesh.indices).setFriction(1.3)) : null);
  }

  function remove(key, c) {
    if (c.ground) physicsWorld.removeCollider(c.ground, false);
    for (const col of c.sheet) if (col) physicsWorld.removeCollider(col, false);
    for (const col of c.colliders ?? []) physicsWorld.removeCollider(col, false);
    c.entity?.destroy();
    chunks.delete(key);
  }

  // With `force`, everything within reach is built now (start, respawn far away).
  function update(x, z, { force = false } = {}) {
    const ccx = Math.floor(x / CHUNK_SIZE);
    const ccz = Math.floor(z / CHUNK_SIZE);
    for (const [key, c] of chunks) {
      if (Math.abs(c.cx - ccx) > radius + 1 || Math.abs(c.cz - ccz) > radius + 1) remove(key, c);
    }
    const jobs = [];
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const cx = ccx + dx;
        const cz = ccz + dz;
        const key = chunkKey(cx, cz);
        let c = chunks.get(key);
        if (!c) chunks.set(key, (c = { cx, cz, ground: null, sheet: [], colliders: null, rocks: null }));
        if (!c.ground || c.sheet.length < ROCK_COLLIDER_BANDS || !c.done) jobs.push([dx * dx + dz * dz, c]);
      }
    }
    jobs.sort((a, b) => a[0] - b[0]);
    for (const [, c] of force ? jobs : jobs.slice(0, 1)) {
      if (!c.ground) buildGround(c);
      else if (c.sheet.length < ROCK_COLLIDER_BANDS) buildSheetBand(c);
      else if (!c.rocks) c.rocks = generateRocks(heightAt, c.cx, c.cz, { count: rockCount });
      else buildRocks(c);
      while (force && c.sheet.length < ROCK_COLLIDER_BANDS) buildSheetBand(c);
      if (force && !c.done) {
        c.rocks ??= generateRocks(heightAt, c.cx, c.cz, { count: rockCount });
        buildRocks(c, true);
      }
    }
  }

  return { update };
}
