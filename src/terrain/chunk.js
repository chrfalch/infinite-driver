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

export function chunkKey(cx, cz) {
  return `${cx},${cz}`;
}
