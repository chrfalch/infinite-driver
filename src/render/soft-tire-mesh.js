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
export function updateGpuTireMesh(object, solver, index) {
  const offset = index * solver.perTire * 4;
  setLattice(object, solver.positions, 4, offset);
  const p = solver.positions;
  setNearbyRocks(object, solver.rockList, [p[offset], p[offset + 1], p[offset + 2]]);
}
