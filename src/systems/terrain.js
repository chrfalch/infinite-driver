import { Group } from 'three/webgpu';
import {
  CameraTarget,
  HeightField,
  Physics,
  Render,
  RockField,
  TerrainChunk,
  TerrainStreaming,
  Transform,
  View,
} from '../ecs/traits.js';
import { createRocksMesh, createRocksMeshFromData } from '../render/rock-mesh.js';
import { createChunkMesh, createChunkMeshFromData } from '../render/terrain-mesh.js';
import { CHUNK_RES, CHUNK_SIZE, chunkKey, sampleChunk } from '../terrain/chunk.js';
import { generatePebbles, generateRocks } from '../terrain/rocks.js';
import { generatePlants } from '../terrain/vegetation.js';
import { createVegetationMesh } from '../render/vegetation-mesh.js';
import { createRockSheetMesh } from '../render/rock-surface.js';
import { createPebbleMesh } from '../render/pebble-mesh.js';
import { ROCK_COLLIDER_BANDS, rockSheetData, rockSheetTrimesh } from '../terrain/rock-sheet.js';
import { timed } from '../perf.js';

// ?rocks=<count per chunk> (default 70); ?rocks=0 gives an empty test ground.
export const ROCK_COUNT = Number(new URLSearchParams(globalThis.location?.search ?? '').get('rocks') ?? 70);

// Work per frame is spread out to avoid hitches when the car crosses a chunk border: at most one
// job per frame (a new chunk's ground mesh, a rock mesh, a ground trimesh collider, or one chunk's
// rock hulls). Colliders are created once per chunk and then only enabled or disabled as the chunk
// leaves and re-enters the collider radius; they are removed when the chunk is unloaded.

// New chunks are built by a worker (terrain/chunk-worker.js): heights, ground mesh data, rocks, and
// plants, about 5-6 ms per chunk on an M4. Here each finished chunk only becomes meshes. The chunk
// under the car after a respawn or teleport cannot wait, so it is still built here; so is the
// initial load, and everything when workers are unavailable.
const AHEAD = 3; // chunks requested from the worker at a time
let chunkWorker = null;

export function startChunkWorker({ mode, rockCount = ROCK_COUNT }) {
  try {
    const worker = new Worker(new URL('../terrain/chunk-worker.js', import.meta.url), { type: 'module' });
    const state = { worker, requested: new Set(), ready: new Map(), sheets: new Map() };
    worker.onmessage = (e) => {
      const msg = e.data;
      const key = chunkKey(msg.cx, msg.cz);
      if (msg.type === 'sheet') {
        state.sheets.set(key, msg);
        return;
      }
      state.requested.delete(key);
      if (msg.type === 'chunk') state.ready.set(key, msg);
      else console.error('[chunk worker]', msg.message);
    };
    worker.onerror = (e) => {
      console.error('[chunk worker]', e.message);
      worker.terminate();
      chunkWorker = null;
    };
    worker.postMessage({ type: 'init', mode, rockCount });
    chunkWorker = state;
  } catch (error) {
    console.warn('Chunk worker unavailable, building terrain on the main thread:', error);
  }
}

// Triangle indices are the same for every chunk.
let trimeshIndices = null;
function chunkIndices(res = CHUNK_RES) {
  if (trimeshIndices) return trimeshIndices;
  const n = res + 1;
  const indices = new Uint32Array(res * res * 6);
  let k = 0;
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const a = ix + iz * n;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }
  return (trimeshIndices = indices);
}

// World-space vertices of a chunk's ground (same layout as chunkTrimesh in terrain/chunk.js).
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

// Ground trimesh collider. Soft bodies collide with triangle meshes but not heightfields.
function addGroundCollider(physics, chunk) {
  const { rapier, world } = physics;
  const desc = rapier.ColliderDesc.trimesh(chunkVertices(chunk.heights, chunk.cx, chunk.cz), chunkIndices()).setFriction(1.0);
  chunk.collider = world.createCollider(desc);
  chunk.collidersEnabled = true;
  // The dry river's rock sheet lies on top of the ground (all bands at once here; the physics
  // worker spreads them out).
  chunk.sheet = [];
  for (let band = 0; band < ROCK_COLLIDER_BANDS; band++) {
    const mesh = rockSheetTrimesh(chunk.heightAt, chunk.cx, chunk.cz, band);
    if (mesh) chunk.sheet.push(world.createCollider(rapier.ColliderDesc.trimesh(mesh.vertices, mesh.indices).setFriction(1.3)));
  }
}

// Bushes and trees are generated on first need (with the rock mesh or the rock colliders), so a new
// chunk's work is spread over separate frames.
function plantsOf(field) {
  field.plants ??= generatePlants(field.heightAt, field.cx, field.cz);
  return field.plants;
}

// Rock hulls are built ROCK_BATCH per call (the dry river has several hundred per chunk); the
// tree trunks come with the last batch. `all` builds everything now.
const ROCK_BATCH = 150;
function addRockColliders(physics, field, all = false) {
  const { rapier, world } = physics;
  field.nextRock ??= 0;
  const end = all ? field.rocks.length : Math.min(field.rocks.length, field.nextRock + ROCK_BATCH);
  for (; field.nextRock < end; field.nextRock++) {
    const desc = rapier.ColliderDesc.convexHull(field.rocks[field.nextRock].vertices);
    if (desc) field.colliders.push(world.createCollider(desc.setFriction(1.3)));
  }
  if (field.nextRock < field.rocks.length) return;
  // Tree trunks are solid (a thin cylinder); bushes are only drawn, the car drives through them.
  for (const p of plantsOf(field)) {
    if (p.kind !== 'tree') continue;
    const r = p.trunk ?? 0.05 * p.height;
    const half = 0.3 * p.height;
    const desc = rapier.ColliderDesc.cylinder(half, r).setTranslation(p.x, p.y + half, p.z).setFriction(0.7);
    field.colliders.push(world.createCollider(desc));
  }
  field.collidersBuilt = true;
}

function setCollidersEnabled(chunk, field, enabled) {
  if (chunk.collidersEnabled === enabled) return;
  chunk.collidersEnabled = enabled;
  if (!chunk.collider && !field.colliders.length) return;
  chunk.collider?.setEnabled(enabled);
  for (const c of chunk.sheet ?? []) c.setEnabled(enabled);
  for (const c of field.colliders) c.setEnabled(enabled);
}

function removeColliders(physics, chunk, field) {
  if (!physics.world) return;
  if (chunk.collider) physics.world.removeCollider(chunk.collider, false);
  for (const c of chunk.sheet ?? []) physics.world.removeCollider(c, false);
  for (const c of field.colliders) physics.world.removeCollider(c, false);
  chunk.collider = null;
  chunk.sheet = null;
  field.colliders = [];
  field.collidersBuilt = false;
  field.nextRock = 0;
}

function disposeView(object) {
  object.traverse((child) => {
    // Plant geometries are shared by every chunk; only their instance buffers belong to it.
    if (child.isInstancedMesh) child.dispose();
    else child.geometry?.dispose();
  });
}

// Keeps a square of chunks loaded around the camera target, and colliders only near it.
// With `force` everything is built at once (initial load).
export function streamTerrain(world, { force = false } = {}) {
  const target = world.queryFirst(CameraTarget, Transform);
  if (!target) return;
  const { position } = target.get(Transform);
  const { radius, colliderRadius } = world.get(TerrainStreaming);
  const physics = world.get(Physics);
  const { scene } = world.get(Render);
  const { heightAt } = world.get(HeightField);

  const ccx = Math.floor(position.x / CHUNK_SIZE);
  const ccz = Math.floor(position.z / CHUNK_SIZE);

  const loaded = new Set();
  // Nearest chunk still missing its ground collider, its rock colliders, or its rock mesh.
  let groundJob = null;
  let groundDist = Infinity;
  let hullJob = null;
  let hullDist = Infinity;
  let rockJob = null;
  let rockDist = Infinity;
  world.query(TerrainChunk, RockField, View).forEach((entity) => {
    const chunk = entity.get(TerrainChunk);
    const field = entity.get(RockField);
    const dx = Math.abs(chunk.cx - ccx);
    const dz = Math.abs(chunk.cz - ccz);
    if (dx > radius + 1 || dz > radius + 1) {
      const { object } = entity.get(View);
      scene.remove(object);
      disposeView(object);
      removeColliders(physics, chunk, field);
      entity.destroy();
      return;
    }
    const dist = dx * dx + dz * dz;
    // With physics in the worker there is no physics world here; the worker builds its own.
    const wantsColliders = !!physics.world && dx <= colliderRadius && dz <= colliderRadius;
    if (wantsColliders) {
      setCollidersEnabled(chunk, field, true);
      if (force) {
        if (!chunk.collider) addGroundCollider(physics, chunk);
        if (!field.collidersBuilt) addRockColliders(physics, field, true);
      } else if (!chunk.collider && dist < groundDist) {
        groundJob = chunk;
        groundDist = dist;
      } else if (!field.collidersBuilt && dist < hullDist) {
        hullJob = field;
        hullDist = dist;
      }
    } else setCollidersEnabled(chunk, field, false);
    if (!field.meshBuilt && (force || dist < rockDist)) {
      if (force) buildRocksMesh(entity, field);
      else {
        rockJob = { entity, field };
        rockDist = dist;
      }
    }
    // A rock sheet and pebbles the chunk worker built for a chunk made here.
    const key = chunkKey(chunk.cx, chunk.cz);
    if (chunkWorker?.sheets.has(key)) {
      const msg = chunkWorker.sheets.get(key);
      chunkWorker.sheets.delete(key);
      for (const mesh of [createRockSheetMesh(msg.sheet), createPebbleMesh(msg.pebbles)]) if (mesh) entity.get(View).object.add(mesh);
    }
    loaded.add(key);
  });

  // Forget rock sheets for chunks that went out of range before theirs arrived.
  if (chunkWorker) for (const key of chunkWorker.sheets.keys()) if (!loaded.has(key)) chunkWorker.sheets.delete(key);

  // Build missing chunks nearest first.
  const missing = [];
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (!loaded.has(chunkKey(ccx + dx, ccz + dz))) missing.push([ccx + dx, ccz + dz, dx * dx + dz * dz]);
    }
  }
  missing.sort((a, b) => a[2] - b[2]);
  if (force) {
    for (const [cx, cz] of missing) spawnChunk(world, physics, scene, heightAt, cx, cz, { ground: true, rocks: true, near: isNear(cx, cz) });
    return;
  }

  // One job per frame (each takes about 1-2.5 ms), in order of urgency: the ground collider the
  // car drives on, a new chunk, rock colliders, then rock meshes. A chunk border crossing is
  // done in about 16 frames; everything that changes is at least one chunk (64 m) away.
  // With the chunk worker: keep the nearest missing chunks requested, forget finished ones that
  // went out of range, and take the nearest finished one (or the one under the car, built here).
  let next = null;
  if (chunkWorker) {
    const wanted = new Set(missing.map(([cx, cz]) => chunkKey(cx, cz)));
    for (const key of chunkWorker.ready.keys()) if (!wanted.has(key)) chunkWorker.ready.delete(key);
    for (const [cx, cz] of missing.slice(0, AHEAD)) {
      const key = chunkKey(cx, cz);
      if (!chunkWorker.requested.has(key) && !chunkWorker.ready.has(key)) {
        chunkWorker.requested.add(key);
        chunkWorker.worker.postMessage({ type: 'chunk', cx, cz });
      }
    }
    next = missing.find(([cx, cz]) => chunkWorker.ready.has(chunkKey(cx, cz)) || (cx === ccx && cz === ccz));
  } else next = missing[0];

  if (groundJob) timed('terrain.groundCollider', () => addGroundCollider(physics, groundJob));
  else if (next) {
    const [cx, cz] = next;
    const key = chunkKey(cx, cz);
    const data = chunkWorker?.ready.get(key) ?? null;
    chunkWorker?.ready.delete(key);
    // A chunk that appears under the car (respawn, teleport) needs its ground and rocks right away.
    const here = cx === ccx && cz === ccz;
    timed('terrain.spawnChunk', () => spawnChunk(world, physics, scene, heightAt, cx, cz, { ground: here, rocks: here, near: isNear(cx, cz) }, data));
  } else if (hullJob) timed('terrain.rockColliders', () => addRockColliders(physics, hullJob));
  else if (rockJob) timed('terrain.rockMesh', () => buildRocksMesh(rockJob.entity, rockJob.field));

  function isNear(cx, cz) {
    return Math.abs(cx - ccx) <= colliderRadius && Math.abs(cz - ccz) <= colliderRadius;
  }
}

// `data`: the chunk as built by the chunk worker, or null to build it here.
function spawnChunk(world, physics, scene, heightAt, cx, cz, { ground, rocks, near }, data = null) {
  const heights = data?.heights ?? timed('terrain.heights', () => sampleChunk(heightAt, cx, cz));
  const chunk = { cx, cz, heights, heightAt, collider: null, sheet: null, collidersEnabled: true };
  const field = {
    rocks: data?.rocks ?? timed('terrain.genRocks', () => generateRocks(heightAt, cx, cz, { count: ROCK_COUNT })),
    colliders: [],
    collidersBuilt: false,
    meshBuilt: false,
    plants: data?.plants ?? null,
    heightAt,
    cx,
    cz,
  };
  if (physics.world && near && ground) addGroundCollider(physics, chunk);
  if (physics.world && near && rocks) addRockColliders(physics, field, true);
  const object = new Group();
  object.name = `chunk ${cx},${cz}`;
  object.add(data ? createChunkMeshFromData(data.mesh, cx, cz) : timed('terrain.chunkMesh', () => createChunkMesh(heightAt, heights, cx, cz)));
  // The dry river's rock sheet and pebbles come with the worker's chunk. For a chunk made here, the
  // worker builds them on the side (they cost ~90 ms) and they are added when they arrive (see
  // streamTerrain).
  if (!data && chunkWorker && heightAt.rockAt) chunkWorker.worker.postMessage({ type: 'sheet', cx, cz });
  const sheet = createRockSheetMesh(data ? data.sheet : chunkWorker ? null : timed('terrain.rockSheet', () => rockSheetData(heightAt, cx, cz)));
  if (sheet) object.add(sheet);
  const pebbles = createPebbleMesh(data ? data.pebbles : chunkWorker ? null : timed('terrain.pebbles', () => generatePebbles(heightAt, cx, cz)));
  if (pebbles) object.add(pebbles);
  scene.add(object);
  const entity = world.spawn(TerrainChunk(chunk), RockField(field), View({ object }));
  // The worker's chunk comes with its rock mesh data and plants, so it is finished right away.
  if (data) buildRocksMesh(entity, field, data.rocksMesh);
  else if (rocks) buildRocksMesh(entity, field);
}

function buildRocksMesh(entity, field, rocksMeshData) {
  field.meshBuilt = true;
  const rocksMesh = rocksMeshData !== undefined ? createRocksMeshFromData(rocksMeshData) : timed('terrain.rockMeshGeo', () => createRocksMesh(field.rocks));
  if (rocksMesh) entity.get(View).object.add(rocksMesh);
  const plants = timed('terrain.plants', () => createVegetationMesh(plantsOf(field)));
  if (plants) {
    entity.get(View).object.add(plants);
    field.bushes = plants.userData.bushes ?? null;
  }
}
