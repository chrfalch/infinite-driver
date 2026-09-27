import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial } from 'three/webgpu';

export const rockMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });

const LIGHT = new Color('#a39a8c');
const DARK = new Color('#6f675d');
// Red sandstone for the canyon.
const RED_LIGHT = new Color('#cf8d62');
const RED_DARK = new Color('#8f4a2d');
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
  let o = 0;
  for (const rock of rocks) {
    if (rock.red) tmp.copy(RED_DARK).lerp(RED_LIGHT, rock.tint);
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
        o += 3;
      }
    }
  }
  return { positions, colors, normals };
}

export function createRocksMeshFromData(data) {
  if (!data) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setAttribute('color', new BufferAttribute(data.colors, 3));
  geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
  geometry.computeBoundingSphere();
  const mesh = new Mesh(geometry, rockMaterial);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
