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

// Samples the ground on the solver's grid, centred on (x, z).
export function updateGpuGround(solver, heightAt, x, z, cell = 0.5) {
  const half = ((GROUND_N - 1) * cell) / 2;
  const ox = Math.round((x - half) / cell) * cell;
  const oz = Math.round((z - half) / cell) * cell;
  if (solver.groundOrigin.x === ox && solver.groundOrigin.z === oz && solver.groundReady) return;
  const heights = new Float32Array(GROUND_N * GROUND_N);
  for (let iz = 0; iz < GROUND_N; iz++) {
    for (let ix = 0; ix < GROUND_N; ix++) heights[iz * GROUND_N + ix] = heightAt(ox + ix * cell, oz + iz * cell);
  }
  solver.setGround(heights, ox, oz, cell);
  solver.groundReady = true;
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
