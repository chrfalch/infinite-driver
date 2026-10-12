import { describe, expect, it } from 'vitest';
import { FADE_END, FADE_START, PATCH_SIZE, SNOW_PATCH_N, SnowSurface } from '../src/render/snow-surface.js';
import { chunkMeshData } from '../src/render/terrain-mesh.js';
import { CHUNK_SIZE, sampleChunk } from '../src/terrain/chunk.js';
import { DEFORM_CELL, GroundDeformation } from '../src/terrain/deformation.js';
import { createHeightField } from '../src/terrain/height.js';

const snowField = createHeightField({ mode: 'snow' });
const scene = { add() {} };
const C = PATCH_SIZE + 1;
const N = SNOW_PATCH_N;

// The terrain mesh's vertex data at whole-metre point (x, z), from the chunk that holds it.
const chunks = new Map();
function terrainVertex(x, z) {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cz = Math.floor(z / CHUNK_SIZE);
  const key = `${cx},${cz}`;
  let chunk = chunks.get(key);
  if (!chunk) {
    const heights = sampleChunk(snowField, cx, cz);
    chunk = { heights, mesh: chunkMeshData(snowField, heights, cx, cz) };
    chunks.set(key, chunk);
  }
  const i = x - cx * CHUNK_SIZE + (z - cz * CHUNK_SIZE) * (CHUNK_SIZE + 1);
  const m = chunk.mesh;
  return { height: chunk.heights[i], gravel: m.gravel[i], normal: [m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]] };
}

describe('snow surface (the snow near the car)', () => {
  it('morphs into the terrain mesh well inside its edge, wherever the car is in it', () => {
    expect(FADE_START).toBeLessThan(FADE_END);
    // The car is at most RECENTRE (4 m) off the centre on each axis before the patch moves.
    expect(FADE_END).toBeLessThan(PATCH_SIZE / 2 - 4);
  });

  it('takes its coarse corners from the terrain mesh, also after moving with the car', () => {
    const surface = new SnowSurface(scene, snowField, new GroundDeformation());
    for (const [x, z] of [[10, 2], [16, 2], [16, -5], [9, 7], [200, -40]]) {
      surface.update(x, z);
      const { x0, z0 } = surface.bounds();
      const [a, b] = surface.corners.map((t) => t.image.data);
      for (const [ix, iz] of [[0, 0], [C - 1, 0], [0, C - 1], [C - 1, C - 1], [3, 7], [24, 24], [41, 5], [6, 44]]) {
        const want = terrainVertex(x0 + ix, z0 + iz);
        const o = (iz * C + ix) * 4;
        expect(a[o + 3]).toBeCloseTo(want.height, 5);
        want.normal.forEach((v, k) => expect(a[o + k]).toBeCloseTo(v, 5));
        expect(b[o]).toBeCloseTo(want.gravel, 5);
      }
    }
  });

  it('keeps the snow surface of the cells it shares with the old patch', () => {
    const surface = new SnowSurface(scene, snowField, new GroundDeformation());
    for (const [x, z] of [[0, 0], [5, 0], [5, 6], [-1, 1]]) {
      surface.update(x, z);
      const snow = surface.snow.image.data;
      for (const [ix, iz] of [[0, 0], [N - 1, N - 1], [17, 300], [192, 192], [380, 3]]) {
        const wx = (surface.ix0 + ix) * DEFORM_CELL;
        const wz = (surface.iz0 + iz) * DEFORM_CELL;
        const i = (iz * N + ix) * 4;
        expect(snow[i]).toBeCloseTo(snowField(wx, wz), 5);
        expect(snow[i + 1]).toBeCloseTo(snowField.snowAt(wx, wz).firm, 5);
        expect(snow[i + 2]).toBeCloseTo(snowField.roadSide(wx, wz), 5);
      }
    }
  });

  it('adds the ruts, faded out toward its edge', () => {
    const deformation = new GroundDeformation();
    const surface = new SnowSurface(scene, snowField, deformation);
    surface.update(0.3, 0.2);
    const { x0, z0 } = surface.bounds();
    const centre = [x0 + PATCH_SIZE / 2, z0 + PATCH_SIZE / 2];
    const edge = [x0, z0 + 10];
    for (const [x, z] of [centre, edge]) deformation.add(x, z, -0.05);
    surface.update(0.3, 0.2);
    const at = ([x, z]) => surface.data[(Math.round((z - z0) / DEFORM_CELL) * N + Math.round((x - x0) / DEFORM_CELL)) * 2];
    expect(at(centre)).toBeCloseTo(deformation.at(...centre), 6);
    expect(at(centre)).toBeLessThan(-0.04);
    expect(Math.abs(at(edge))).toBe(0);
  });
});
