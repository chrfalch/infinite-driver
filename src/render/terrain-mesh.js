import { createNoise2D } from 'simplex-noise';
import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial } from 'three/webgpu';
import { mulberry32 } from '../terrain/height.js';
import { CHUNK_RES, CHUNK_SIZE } from '../terrain/chunk.js';

export const terrainMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });

const DIRT = new Color('#c2ab82');
const DRY = new Color('#b4ad84');
const GRASS = new Color('#98a36f');
const ROCK = new Color('#8a8074');
const tmp = new Color();
const patchNoise = createNoise2D(mulberry32(4242));
const fineNoise = createNoise2D(mulberry32(777));

function colorFor(h, slope, x, z, out) {
  // Soft patches of dirt, dry grass, and greener grass so motion reads on flat ground.
  const p = patchNoise(x * 0.035, z * 0.035) * 0.7 + patchNoise(x * 0.11, z * 0.11) * 0.3;
  if (p < 0) out.copy(DIRT).lerp(DRY, Math.min(1, (p + 0.6) / 0.6));
  else out.copy(DRY).lerp(GRASS, Math.min(1, p / 0.5));
  out.offsetHSL(0, 0, fineNoise(x * 0.6, z * 0.6) * 0.025 + h * 0.004);
  // Steep faces show rock.
  out.lerp(ROCK, Math.min(1, Math.max(0, (slope - 0.35) / 0.3)));
  return out;
}

// Ground colour at a world position, matching the terrain mesh (used by the tyre tracks).
export function terrainColorAt(heightAt, x, z, out = new Color()) {
  const e = 0.5;
  const dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  const dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  return colorFor(heightAt(x, z), Math.hypot(dx, dz), x, z, out);
}

export function createChunkMesh(heightAt, heights, cx, cz, size = CHUNK_SIZE, res = CHUNK_RES) {
  const n = res + 1;
  const step = size / res;
  const x0 = cx * size;
  const z0 = cz * size;
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const e = step;

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = ix + iz * n;
      const x = x0 + ix * step;
      const z = z0 + iz * step;
      const h = heights[i];
      positions.set([x, h, z], i * 3);
      // Normals from the height function itself, so chunk borders match seamlessly.
      const dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
      const dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
      const len = Math.hypot(dx, 1, dz);
      normals.set([-dx / len, 1 / len, -dz / len], i * 3);
      colorFor(h, Math.hypot(dx, dz), x, z, tmp);
      colors.set([tmp.r, tmp.g, tmp.b], i * 3);
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

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();

  const mesh = new Mesh(geometry, terrainMaterial);
  mesh.receiveShadow = true;
  mesh.name = `chunk ${cx},${cz}`;
  return mesh;
}
