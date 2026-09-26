import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { createMtTyreMesh, setLattice, setNearbyRocks } from './mt-tyre.js';

// A world-space mud-terrain tyre carried by a soft tyre's particles (see mt-tyre.js): the tread
// blocks ride on the particle lattice, so rolling and squash show in the tread.
export function createSoftTireMesh(soft, mesh) {
  const object = createMtTyreMesh(mesh);
  if (soft) setLattice(object, soft.particlePositions(), 3);
  return object;
}

export function updateSoftTireMesh(object, soft) {
  setLattice(object, soft.particlePositions(), 3);
}

// GPU solver positions are vec4 per particle; tyre `index` occupies one contiguous block.
export function updateGpuTireMesh(object, solver, index, hub = null) {
  const offset = index * solver.perTire * 4;
  setLattice(object, solver.positions, 4, offset);
  const p = solver.positions;
  setNearbyRocks(object, solver.rockList, [p[offset], p[offset + 1], p[offset + 2]]);
  // The shape was read back at the end of the last physics batch; physics may have stepped on since
  // (a batch can span frames). Carry the shape rigidly from the hub pose at readback to the hub's
  // pose now, so a tyre never trails its wheel.
  const from = solver.readbackHubs?.[index];
  object.matrixAutoUpdate = false;
  if (!from || !hub) {
    object.matrix.identity();
    return;
  }
  const t = hub.translation();
  const r = hub.rotation();
  nowPose.compose(tmpV.set(t.x, t.y, t.z), tmpQ.set(r.x, r.y, r.z, r.w), ONE);
  thenPose.compose(tmpV.set(from.p.x, from.p.y, from.p.z), tmpQ.set(from.q.x, from.q.y, from.q.z, from.q.w), ONE);
  object.matrix.multiplyMatrices(nowPose, thenPose.invert());
  object.matrixWorldNeedsUpdate = true;
}
const nowPose = new Matrix4();
const thenPose = new Matrix4();
const tmpV = new Vector3();
const tmpQ = new Quaternion();
const ONE = new Vector3(1, 1, 1);
