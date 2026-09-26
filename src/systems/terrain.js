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
import { createRocksMesh } from '../render/rock-mesh.js';
import { createChunkMesh } from '../render/terrain-mesh.js';
import { CHUNK_RES, CHUNK_SIZE, chunkKey, sampleChunk, toRapierHeights } from '../terrain/chunk.js';
import { generateRocks } from '../terrain/rocks.js';

const MAX_BUILDS_PER_FRAME = 2;

function addColliders(physics, chunk, field) {
  const { rapier, world } = physics;
  const ground = rapier.ColliderDesc.heightfield(CHUNK_RES, CHUNK_RES, toRapierHeights(chunk.heights), {
    x: CHUNK_SIZE,
    y: 1,
    z: CHUNK_SIZE,
  })
    .setTranslation((chunk.cx + 0.5) * CHUNK_SIZE, 0, (chunk.cz + 0.5) * CHUNK_SIZE)
    .setFriction(1.0);
  chunk.collider = world.createCollider(ground);
  field.colliders = field.rocks
    .map((rock) => rapier.ColliderDesc.convexHull(rock.vertices))
    .filter(Boolean)
    .map((desc) => world.createCollider(desc.setFriction(0.9)));
}

function removeColliders(physics, chunk, field) {
  if (chunk.collider) physics.world.removeCollider(chunk.collider, false);
  for (const c of field.colliders) physics.world.removeCollider(c, false);
  chunk.collider = null;
  field.colliders = [];
}

function disposeView(object) {
  object.traverse((child) => child.geometry?.dispose());
}

// Keeps a square of chunks loaded around the camera target, and colliders only near it.
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
    const wantsColliders = dx <= colliderRadius && dz <= colliderRadius;
    if (wantsColliders && !chunk.collider) addColliders(physics, chunk, field);
    if (!wantsColliders && chunk.collider) removeColliders(physics, chunk, field);
    loaded.add(chunkKey(chunk.cx, chunk.cz));
  });

  // Build missing chunks nearest first, a few per frame to avoid hitches.
  const missing = [];
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (!loaded.has(chunkKey(ccx + dx, ccz + dz))) missing.push([ccx + dx, ccz + dz, dx * dx + dz * dz]);
    }
  }
  missing.sort((a, b) => a[2] - b[2]);
  const budget = force ? missing.length : MAX_BUILDS_PER_FRAME;
  for (const [cx, cz] of missing.slice(0, budget)) {
    const heights = sampleChunk(heightAt, cx, cz);
    const chunk = { cx, cz, heights, collider: null };
    const field = { rocks: generateRocks(heightAt, cx, cz), colliders: [] };
    if (Math.abs(cx - ccx) <= colliderRadius && Math.abs(cz - ccz) <= colliderRadius) addColliders(physics, chunk, field);

    const object = new Group();
    object.name = `chunk ${cx},${cz}`;
    object.add(createChunkMesh(heightAt, heights, cx, cz));
    const rocksMesh = createRocksMesh(field.rocks);
    if (rocksMesh) object.add(rocksMesh);
    scene.add(object);
    world.spawn(TerrainChunk(chunk), RockField(field), View({ object }));
  }
}
