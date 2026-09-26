import { DEFAULT_TIRE, GPU_TIRE, TIRE } from './config.js';
import { GpuTireSolver, GROUND_N, rockToGpu } from './gpu-tire-solver.js';
import { torusMesh } from './soft-tire.js';

// Builds the mesh description and GPU solver for `count` tyres with the current settings.
export function createGpuTires(device, count, tire = TIRE, gpu = GPU_TIRE) {
  const shape = { ...DEFAULT_TIRE, ...tire, segmentsAround: gpu.segmentsAround, segmentsAcross: gpu.segmentsAcross, beadRings: 0 };
  const mesh = torusMesh(shape);
  const mirrored = torusMesh(shape, { mirror: true });
  const inner = Math.round(mesh.nv / 2);
  const spread = Math.max(0, Math.round(gpu.beadRings));
  const solver = new GpuTireSolver(device, {
    nu: mesh.nu,
    nv: mesh.nv,
    tires: count,
    restLocal: mesh.vertices,
    beadLow: inner - spread,
    beadHigh: inner + spread,
  });
  return { solver, mesh, mirrored };
}

// Samples the ground (terrain plus ruts) on the solver's grid, centred on (x, z). The grid spacing
// matches the deformation map, so ruts are read cell for cell.
export function updateGpuGround(solver, heightAt, x, z, deformation = null, cell = 0.125) {
  const half = ((GROUND_N - 1) * cell) / 2;
  const ix0 = Math.round((x - half) / cell);
  const iz0 = Math.round((z - half) / cell);
  const ox = ix0 * cell;
  const oz = iz0 * cell;
  const version = deformation?.version ?? 0;
  if (solver.groundReady && solver.groundOrigin.x === ox && solver.groundOrigin.z === oz && solver.groundVersion === version) return;
  const heights = solver.groundScratch ?? (solver.groundScratch = new Float32Array(GROUND_N * GROUND_N));
  for (let iz = 0; iz < GROUND_N; iz++) {
    for (let ix = 0; ix < GROUND_N; ix++) {
      const offset = deformation ? deformation.cellValue(ix0 + ix, iz0 + iz) : 0;
      heights[iz * GROUND_N + ix] = heightAt(ox + ix * cell, oz + iz * cell) + offset;
    }
  }
  solver.setGround(heights, ox, oz, cell);
  solver.groundReady = true;
  solver.groundVersion = version;
}

// Picks the rocks nearest to (x, z) and uploads them as convex shapes.
export function updateGpuRocks(solver, rocks, x, z, range = 14) {
  const near = rocks
    .map((rock) => ({ rock, dist: Math.hypot(rock.x - x, rock.z - z) }))
    .filter((r) => r.dist < range + r.rock.size * 2)
    .sort((a, b) => a.dist - b.dist)
    .map((r) => {
      r.rock.gpu ??= rockToGpu(r.rock);
      return r.rock.gpu;
    });
  solver.setRocks(near);
}
