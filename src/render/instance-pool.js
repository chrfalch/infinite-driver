// Instanced meshes for things every terrain chunk has (plants, pebbles), kept when a chunk goes
// and handed to the next one. three keys an instanced mesh's shader by the mesh itself (its uuid,
// see RenderObject.getMaterialCacheKey), so every new one built its node graph again, about 8 ms
// each and 20-40 of them for the chunks round a teleport. A mesh used before is drawn straight away.
import { InstancedMesh } from 'three/webgpu';

const free = new Map(); // `${geometry.id}|${material.id}` -> meshes, any capacity
const MIN_CAPACITY = 16;
export const poolStats = { created: 0, reused: 0 };
const WARM_FRAMES = 2;
const warming = [];

// Once a frame, after drawing: new meshes go back to being culled once they have been drawn.
export function warmInstancedMeshes() {
  for (let i = warming.length - 1; i >= 0; i--) {
    if (--warming[i].frames > 0) continue;
    warming[i].mesh.frustumCulled = true;
    warming[i] = warming[warming.length - 1];
    warming.pop();
  }
}

// A mesh drawing `count` instances of `geometry` in `material`, at the origin, its instance
// colours (if it has them) white. Fill its matrices (and colours) as for a new one.
export function takeInstancedMesh(geometry, material, count) {
  const key = `${geometry.id}|${material.id}`;
  const list = free.get(key);
  // The smallest kept mesh with room for them all.
  let best = -1;
  if (list) for (let i = 0; i < list.length; i++) if (list[i].instanceMatrix.count >= count && (best < 0 || list[i].instanceMatrix.count < list[best].instanceMatrix.count)) best = i;
  let mesh;
  if (best < 0) {
    const capacity = Math.max(MIN_CAPACITY, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
    mesh = new InstancedMesh(geometry, material, capacity);
    mesh.userData.poolKey = key;
    poolStats.created++;
    // Drawn on its first frames wherever it is, so its shaders (main, shadow and depth-of-field
    // passes) are built now, with the chunk, and not when it first comes into view; after that it is
    // culled as usual (see warmInstancedMeshes).
    mesh.frustumCulled = false;
    warming.push({ mesh, frames: WARM_FRAMES });
  } else {
    mesh = list[best];
    list[best] = list[list.length - 1];
    list.pop();
    poolStats.reused++;
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.set(1, 1, 1);
    mesh.updateMatrix();
    mesh.visible = true;
    mesh.name = '';
    mesh.boundingBox = null;
    mesh.boundingSphere = null;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.array.fill(1);
      mesh.instanceColor.clearUpdateRanges();
      mesh.instanceColor.needsUpdate = true;
    }
  }
  mesh.count = count;
  return mesh;
}

// Takes the mesh out of the scene and keeps it for takeInstancedMesh (others are disposed).
export function releaseInstancedMesh(mesh) {
  mesh.removeFromParent();
  const key = mesh.userData.poolKey;
  if (!key) return mesh.dispose();
  if (!free.has(key)) free.set(key, []);
  free.get(key).push(mesh);
}
