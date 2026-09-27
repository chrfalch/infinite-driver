import { InstancedMesh, Matrix4 } from 'three/webgpu';

// Draws many moving parts with few draw calls. Meshes under `root` that share a shape and a
// material (the four lower arms, the sixteen joint balls, …) are drawn as one InstancedMesh whose
// instance matrices are copied from the originals' world matrices every frame. The originals stay
// in the scene graph, so the code that poses them is unchanged; they are only moved to a layer no
// camera renders. Shapes match by their vertex data.
// Static parts should be merged instead (see mergeByMaterial).

const HIDDEN_LAYER = 31;
const active = new Set();
// Instanced meshes of disposed batchers, kept (hidden, in the scene) by shape, material, and count:
// a rebuilt car has the same parts, and reusing the meshes spares the renderer setting up new ones
// (about 120 ms on an M4 for a whole car).
const pool = new Map();
const NOTHING = new Matrix4().makeScale(0, 0, 0);

// A part hidden by its posing code (itself or a parent invisible) must not show as an instance.
function shown(object) {
  for (let o = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

// Same key for geometries that would draw the same triangles. Built from the vertex data (not the
// constructor parameters), because a geometry can be translated or rotated after it is built.
function shapeKey(geometry) {
  const pos = geometry.getAttribute('position');
  const index = geometry.index;
  let hash = 0;
  const step = Math.max(1, Math.floor(pos.array.length / 64));
  for (let i = 0; i < pos.array.length; i += step) hash = (Math.imul(hash, 31) + Math.round(pos.array[i] * 1e4)) | 0;
  return `${pos.count}:${index ? index.count : 0}:${hash}`;
}

export function createInstanceBatcher(root, scene, { minCount = 2 } = {}) {
  const groups = new Map();
  root.traverse((object) => {
    if (!object.isMesh || object.isInstancedMesh || object.isSkinnedMesh || Array.isArray(object.material)) return;
    const key = `${shapeKey(object.geometry)}|${object.material.uuid}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = []));
    group.push(object);
  });

  const batches = [];
  for (const [key, meshes] of groups) {
    if (meshes.length < minCount) continue;
    const poolKey = `${key}|${meshes.length}`;
    let mesh = pool.get(poolKey)?.pop();
    if (mesh) mesh.visible = true;
    else {
      const first = meshes[0];
      // Its own copy of the geometry: the originals' geometries are disposed with the car.
      mesh = new InstancedMesh(first.geometry.clone(), first.material, meshes.length);
      // Instance matrices are world matrices; the parts are always near the car, so no culling.
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.name = `instanced ${first.geometry.type}`;
      mesh.userData.poolKey = poolKey;
      scene.add(mesh);
    }
    mesh.castShadow = meshes.some((m) => m.castShadow);
    mesh.receiveShadow = meshes.some((m) => m.receiveShadow);
    for (const m of meshes) m.layers.set(HIDDEN_LAYER);
    batches.push({ mesh, meshes });
  }

  const batcher = {
    batches,
    // Copies each part's world matrix into its instance (call after the scene's world matrices
    // are up to date, before drawing).
    update() {
      for (const { mesh, meshes } of batches) {
        for (let i = 0; i < meshes.length; i++) mesh.setMatrixAt(i, shown(meshes[i]) ? meshes[i].matrixWorld : NOTHING);
        mesh.instanceMatrix.needsUpdate = true;
      }
    },
    // Hides the instanced meshes and keeps them for the next batcher with the same parts.
    dispose() {
      for (const { mesh, meshes } of batches) {
        mesh.visible = false;
        const key = mesh.userData.poolKey;
        if (!pool.has(key)) pool.set(key, []);
        pool.get(key).push(mesh);
        for (const m of meshes) m.layers.set(0);
      }
      batches.length = 0;
      active.delete(batcher);
    },
  };
  active.add(batcher);
  return batcher;
}

// Updates every live batcher (once per frame, before drawing).
export function updateInstanceBatchers() {
  for (const batcher of active) batcher.update();
}
