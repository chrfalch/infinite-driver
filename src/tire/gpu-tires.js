import { DEFAULT_TIRE, GPU_TIRE, TIRE } from './config.js';
import { GpuTireSolver, GROUND_N, rockToGpu } from './gpu-tire-solver.js';
import { torusMesh } from './soft-tire.js';

// The tyre mesh descriptions (left and mirrored right) for the current settings; the solver's
// particles follow the same grid.
export function gpuTireMeshes(tire = TIRE, gpu = GPU_TIRE) {
  const shape = { ...DEFAULT_TIRE, ...tire, segmentsAround: gpu.segmentsAround, segmentsAcross: gpu.segmentsAcross, beadRings: 0 };
  return { mesh: torusMesh(shape), mirrored: torusMesh(shape, { mirror: true }) };
}

// Builds the mesh description and GPU solver for `count` tyres with the current settings.
export function createGpuTires(device, count, tire = TIRE, gpu = GPU_TIRE) {
  const { mesh, mirrored } = gpuTireMeshes(tire, gpu);
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

const RECENTRE = 1; // metres the car may drift from the grid centre before it is re-centred

// Samples the ground (terrain plus ruts) on the solver's grid around (x, z). The grid spacing
// matches the deformation map, so ruts are read cell for cell. The grid only moves when the car is
// RECENTRE metres off its centre (terrain heights of the overlap are kept), and rut changes are
// patched in from the deformation's dirty rectangle, so most frames do little or nothing.
export function updateGpuGround(solver, heightAt, x, z, deformation = null, cell = 0.125) {
  const N = GROUND_N;
  const half = ((N - 1) * cell) / 2;
  let g = solver.groundCache;
  const compatible = g && solver.groundReady && g.cell === cell && g.heightAt === heightAt && g.deformation === deformation;
  const recentre =
    !compatible || Math.abs(x - (g.ix0 * cell + half)) >= RECENTRE || Math.abs(z - (g.iz0 * cell + half)) >= RECENTRE;
  const version = deformation?.version ?? 0;
  if (!recentre && g.version === version) return;

  if (!g) {
    g = solver.groundCache = { base: new Float32Array(N * N), heights: new Float32Array(N * N), spare: new Float32Array(N * N) };
  }
  const { heights } = g;
  if (recentre) {
    const ix0 = Math.round((x - half) / cell);
    const iz0 = Math.round((z - half) / cell);
    const ox = ix0 * cell;
    const oz = iz0 * cell;
    // Terrain heights: keep the overlap with the previous grid, sample the rest.
    const base = g.spare;
    const reuse = compatible && g.cell === cell;
    const sx = reuse ? ix0 - g.ix0 : N;
    const sz = reuse ? iz0 - g.iz0 : N;
    for (let iz = 0; iz < N; iz++) {
      const pz = iz + sz;
      const rowReuse = pz >= 0 && pz < N;
      for (let ix = 0; ix < N; ix++) {
        const px = ix + sx;
        base[iz * N + ix] = rowReuse && px >= 0 && px < N ? g.base[pz * N + px] : heightAt(ox + ix * cell, oz + iz * cell);
      }
    }
    g.spare = g.base;
    g.base = base;
    g.ix0 = ix0;
    g.iz0 = iz0;
    g.cell = cell;
    g.heightAt = heightAt;
    g.deformation = deformation;
    heights.set(base);
    if (deformation) {
      deformation.accumulate(ix0, iz0, N, N, heights);
      // The whole grid is fresh, so restart the deformation's change tracking.
      deformation.changedSince(version);
    }
  } else {
    // Same grid, the ruts changed: refresh only the changed cells inside it.
    const r = deformation.changedSince(g.version);
    let x0 = 0, z0 = 0, x1 = N - 1, z1 = N - 1;
    if (r) {
      x0 = Math.max(0, r.x0 - g.ix0);
      z0 = Math.max(0, r.z0 - g.iz0);
      x1 = Math.min(N - 1, r.x1 - g.ix0);
      z1 = Math.min(N - 1, r.z1 - g.iz0);
    }
    g.version = version;
    if (x0 > x1 || z0 > z1) return;
    const nx = x1 - x0 + 1;
    for (let iz = z0; iz <= z1; iz++) {
      const o = iz * N + x0;
      heights.set(g.base.subarray(o, o + nx), o);
    }
    deformation.accumulate(g.ix0 + x0, g.iz0 + z0, nx, z1 - z0 + 1, heights, N, z0 * N + x0);
  }
  g.version = version;
  solver.setGround(heights, g.ix0 * cell, g.iz0 * cell, cell);
  solver.groundReady = true;
  solver.groundVersion = version;
}

// Ground height (terrain plus ruts) at (x, z) from the solver's grid, interpolated on the same
// triangles as the shader (without gravel), or null outside the grid. A few array reads instead of
// the canyon height function, for per-particle work on the CPU such as finding track contacts.
export function gpuGroundHeight(solver, x, z) {
  const g = solver.groundCache;
  if (!g || !solver.groundReady) return null;
  const N = GROUND_N;
  const gx = x / g.cell - g.ix0;
  const gz = z / g.cell - g.iz0;
  if (!(gx >= 0 && gz >= 0 && gx < N - 1 && gz < N - 1)) return null;
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const fx = gx - ix;
  const fz = gz - iz;
  const h = g.heights;
  const o = iz * N + ix;
  const h00 = h[o];
  const h10 = h[o + 1];
  const h01 = h[o + N];
  const h11 = h[o + N + 1];
  if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
  return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
}

// Picks the rocks nearest to (x, z) and uploads them as convex shapes. The set is refreshed every
// 3 m the car moves, and a wheel is at most about 1.7 m from the car's centre, so a tyre stays
// within about 5.2 m of (x, z) (with its radius) until the next refresh; 6.5 m plus the rock's own
// size leaves margin.
export function updateGpuRocks(solver, rocks, x, z, range = 6.5) {
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
