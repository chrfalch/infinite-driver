import { describe, expect, it } from 'vitest';
import { GroundSurface, PATCH_SIZE } from '../src/render/ground-surface.js';
import { chunkMeshData } from '../src/render/terrain-mesh.js';
import { CHUNK_SIZE, sampleChunk } from '../src/terrain/chunk.js';
import { GroundDeformation, DEFORM_CELL } from '../src/terrain/deformation.js';
import { createHeightField } from '../src/terrain/height.js';

const canyon = createHeightField({ mode: 'canyon' });
const scene = { add() {} };
const C = PATCH_SIZE + 1;
const PER_METRE = Math.round(1 / DEFORM_CELL);

// The terrain mesh's vertex data at whole-metre point (x, z), from the chunk that holds it.
function terrainVertex(heightAt, x, z) {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cz = Math.floor(z / CHUNK_SIZE);
  const key = `${cx},${cz}`;
  terrainVertex.cache ??= new Map();
  let chunk = terrainVertex.cache.get(key);
  if (!chunk) {
    const heights = sampleChunk(heightAt, cx, cz);
    chunk = { heights, mesh: chunkMeshData(heightAt, heights, cx, cz) };
    terrainVertex.cache.set(key, chunk);
  }
  const i = x - cx * CHUNK_SIZE + (z - cz * CHUNK_SIZE) * (CHUNK_SIZE + 1);
  const m = chunk.mesh;
  return {
    color: [m.colors[i * 3], m.colors[i * 3 + 1], m.colors[i * 3 + 2]],
    gravel: m.gravel[i],
    roadDist: m.roadDist[i],
    steep: m.steep[i],
    height: chunk.heights[i],
    normal: [m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]],
  };
}

function cornerAt(surface, ix, iz) {
  const [a, b, n] = surface.corners.map((t) => t.image.data);
  const o = (iz * C + ix) * 4;
  return {
    color: [a[o], a[o + 1], a[o + 2]],
    gravel: a[o + 3],
    roadDist: b[o],
    steep: b[o + 1],
    height: b[o + 3],
    normal: [n[o], n[o + 1], n[o + 2]],
  };
}

function expectSame(got, want) {
  for (const key of Object.keys(want)) {
    const g = [got[key]].flat();
    const w = [want[key]].flat();
    w.forEach((v, k) => expect(g[k]).toBeCloseTo(v, 5));
  }
}

describe('ground surface (the rutted ground near the car)', () => {
  it('takes its corners from the terrain mesh, also after moving with the car', () => {
    const surface = new GroundSurface(scene, canyon, new GroundDeformation());
    // Start, then moves in x, in z and diagonally (the overlap is kept, the new strips worked out).
    for (const [x, z] of [[10, 20], [16, 20], [16, 13], [9, 25], [200, -40]]) {
      surface.update(x, z);
      for (const [ix, iz] of [[0, 0], [C - 1, 0], [0, C - 1], [C - 1, C - 1], [3, 7], [24, 24], [41, 5], [6, 44]]) {
        expectSame(cornerAt(surface, ix, iz), terrainVertex(canyon, surface.ix0 + ix, surface.iz0 + iz));
      }
    }
  });

  it('adds the ruts, faded out toward its edge so it meets the terrain mesh', () => {
    const deformation = new GroundDeformation();
    const surface = new GroundSurface(scene, canyon, deformation);
    surface.update(0.3, 0.2);
    const { ix0, iz0 } = surface;
    // A rut at the centre and one on the edge.
    const centre = [ix0 + PATCH_SIZE / 2, iz0 + PATCH_SIZE / 2];
    const edge = [ix0, iz0 + 10];
    for (const [x, z] of [centre, edge]) deformation.add(x, z, -0.05);
    surface.update(0.3, 0.2);
    const N = PATCH_SIZE * PER_METRE + 1;
    const at = ([x, z]) => surface.deform.image.data[Math.round((z - iz0) * PER_METRE) * N + Math.round((x - ix0) * PER_METRE)];
    expect(at(centre)).toBeCloseTo(deformation.at(...centre), 6);
    expect(at(centre)).toBeLessThan(-0.04);
    expect(Math.abs(at(edge))).toBe(0);
  });
});
