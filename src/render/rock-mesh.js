import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial } from 'three/webgpu';
import { RIVER_PBR, rockDetailMaterial } from './river-ground.js';

// With the dry river's photo look (?ground=pbr), sandstone texture detail over each rock's colour.
export const rockMaterial = RIVER_PBR
  ? rockDetailMaterial({ size: 1.2, bedMatch: true })
  : new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });

const LIGHT = new Color('#a39a8c');
const DARK = new Color('#6f675d');
// Red sandstone for the canyon.
const RED_LIGHT = new Color('#cf8d62');
const RED_DARK = new Color('#8f4a2d');
// Yellow-grey sandstone for the dry river.
const SAND_LIGHT = new Color('#d8c08e');
const SAND_DARK = new Color('#8f7a55');
const SAND_GREY = new Color('#a09a8e');
const tmp = new Color();

// All rocks of a chunk merged into one flat-shaded mesh.
export function createRocksMesh(rocks) {
  return createRocksMeshFromData(rocksMeshData(rocks));
}

// The rock mesh's vertex data (plain arrays, so a worker can build it): one triangle per face,
// each with its face normal (flat shading).
export function rocksMeshData(rocks) {
  const triangles = rocks.reduce((n, r) => n + r.faces.length, 0);
  if (triangles === 0) return null;
  const positions = new Float32Array(triangles * 9);
  const colors = new Float32Array(triangles * 9);
  const normals = new Float32Array(triangles * 9);
  // Per vertex: 0 for a rock that keeps its own colour, else how bright it is when it takes the bed
  // rock's colour instead (dry river photo look, render/river-ground.js; half the rocks).
  const bed = new Float32Array(triangles * 3);
  let o = 0;
  for (const rock of rocks) {
    const match = rock.sand && (rock.tint * 13.7) % 1 < 0.5 ? 0.75 + 0.5 * ((rock.tint * 29.3) % 1) : 0;
    if (rock.red) tmp.copy(RED_DARK).lerp(RED_LIGHT, rock.tint);
    else if (rock.sand) tmp.copy(SAND_DARK).lerp(SAND_LIGHT, rock.tint).lerp(SAND_GREY, ((rock.tint * 7.3) % 1) * 0.55);
    else tmp.copy(DARK).lerp(LIGHT, rock.tint);
    const v = rock.vertices;
    for (const [a, b, c] of rock.faces) {
      const ux = v[b * 3] - v[a * 3], uy = v[b * 3 + 1] - v[a * 3 + 1], uz = v[b * 3 + 2] - v[a * 3 + 2];
      const wx = v[c * 3] - v[a * 3], wy = v[c * 3 + 1] - v[a * 3 + 1], wz = v[c * 3 + 2] - v[a * 3 + 2];
      let nx = uy * wz - uz * wy;
      let ny = uz * wx - ux * wz;
      let nz = ux * wy - uy * wx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      for (const vi of [a, b, c]) {
        positions[o] = v[vi * 3];
        positions[o + 1] = v[vi * 3 + 1];
        positions[o + 2] = v[vi * 3 + 2];
        colors[o] = tmp.r;
        colors[o + 1] = tmp.g;
        colors[o + 2] = tmp.b;
        normals[o] = nx;
        normals[o + 1] = ny;
        normals[o + 2] = nz;
        bed[o / 3] = match;
        o += 3;
      }
    }
  }
  return { positions, colors, normals, bed };
}

export function createRocksMeshFromData(data) {
  if (!data) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setAttribute('color', new BufferAttribute(data.colors, 3));
  geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
  if (data.bed) geometry.setAttribute('bed', new BufferAttribute(data.bed, 1));
  geometry.computeBoundingSphere();
  const mesh = new Mesh(geometry, rockMaterial);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
