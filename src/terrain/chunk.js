// A chunk is a square of CHUNK_SIZE metres sampled on a (CHUNK_RES + 1)^2 grid.
export const CHUNK_SIZE = 64;
export const CHUNK_RES = 64;

// Heights in grid order: index = ix + iz * (res + 1), x = local column, z = local row.
export function sampleChunk(heightAt, cx, cz, size = CHUNK_SIZE, res = CHUNK_RES) {
  const n = res + 1;
  const heights = new Float32Array(n * n);
  const x0 = cx * size;
  const z0 = cz * size;
  const step = size / res;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      heights[ix + iz * n] = heightAt(x0 + ix * step, z0 + iz * step);
    }
  }
  return heights;
}

// Rapier wants a column-major matrix with rows along local z and columns along local x.
export function toRapierHeights(heights, res = CHUNK_RES) {
  const n = res + 1;
  const out = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      out[iz + ix * n] = heights[ix + iz * n];
    }
  }
  return out;
}

// World-space triangle mesh of a chunk, split along the same diagonal as the render mesh and
// wound so normals face up. Soft bodies collide with triangle meshes but not heightfields.
export function chunkTrimesh(heights, cx, cz, size = CHUNK_SIZE, res = CHUNK_RES) {
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
  const indices = new Uint32Array(res * res * 6);
  let k = 0;
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const a = ix + iz * n;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices.set([a, c, b, b, c, d], k);
      k += 6;
    }
  }
  return { vertices, indices };
}

export function chunkKey(cx, cz) {
  return `${cx},${cz}`;
}
