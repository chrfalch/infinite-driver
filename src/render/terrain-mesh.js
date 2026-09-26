import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial } from 'three/webgpu';
import { CHUNK_RES, CHUNK_SIZE } from '../terrain/chunk.js';

export const terrainMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });

const LOW = new Color('#c9b98f'); // dry sand in the hollows
const MID = new Color('#8fa36a'); // soft grass
const HIGH = new Color('#b8c49a'); // pale ridge grass
const ROCK = new Color('#8a8074');
const tmp = new Color();

function colorFor(h, slope, x, z, out) {
  const t = Math.min(1, Math.max(0, (h + 10) / 26));
  if (t < 0.35) out.copy(LOW).lerp(MID, t / 0.35);
  else out.copy(MID).lerp(HIGH, (t - 0.35) / 0.65);
  // Steep faces show rock.
  const rock = Math.min(1, Math.max(0, (slope - 0.35) / 0.3));
  out.lerp(ROCK, rock);
  // Tiny deterministic speckle so large flats are not a flat colour.
  const n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  const speckle = (n - Math.floor(n) - 0.5) * 0.012;
  out.offsetHSL(0, 0, speckle);
  return out;
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
      // Split along the same diagonal as Rapier's heightfield triangles.
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
