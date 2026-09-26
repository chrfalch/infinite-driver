import { CameraTarget, HeightField, Physics, Render, TerrainChunk, TerrainStreaming, Transform, View } from '../ecs/traits.js';
import { CHUNK_RES, CHUNK_SIZE, chunkKey, sampleChunk, toRapierHeights } from '../terrain/chunk.js';
import { createChunkMesh } from '../render/terrain-mesh.js';

const MAX_BUILDS_PER_FRAME = 2;

function addCollider(physics, chunk) {
  const { rapier, world } = physics;
  const desc = rapier.ColliderDesc.heightfield(CHUNK_RES, CHUNK_RES, toRapierHeights(chunk.heights), {
    x: CHUNK_SIZE,
    y: 1,
    z: CHUNK_SIZE,
  })
    .setTranslation((chunk.cx + 0.5) * CHUNK_SIZE, 0, (chunk.cz + 0.5) * CHUNK_SIZE)
    .setFriction(1.0);
  chunk.collider = world.createCollider(desc);
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

  const loaded = new Map();
  world.query(TerrainChunk, View).forEach((entity) => {
    const chunk = entity.get(TerrainChunk);
    const dx = Math.abs(chunk.cx - ccx);
    const dz = Math.abs(chunk.cz - ccz);
    if (dx > radius + 1 || dz > radius + 1) {
      const view = entity.get(View);
      scene.remove(view.object);
      view.object.geometry.dispose();
      if (chunk.collider) physics.world.removeCollider(chunk.collider, false);
      entity.destroy();
      return;
    }
    const wantsCollider = dx <= colliderRadius && dz <= colliderRadius;
    if (wantsCollider && !chunk.collider) addCollider(physics, chunk);
    if (!wantsCollider && chunk.collider) {
      physics.world.removeCollider(chunk.collider, false);
      chunk.collider = null;
    }
    loaded.set(chunkKey(chunk.cx, chunk.cz), entity);
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
    if (Math.abs(cx - ccx) <= colliderRadius && Math.abs(cz - ccz) <= colliderRadius) addCollider(physics, chunk);
    const mesh = createChunkMesh(heightAt, heights, cx, cz);
    scene.add(mesh);
    world.spawn(TerrainChunk(chunk), View({ object: mesh }));
  }
}
