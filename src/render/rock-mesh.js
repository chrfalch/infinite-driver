import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial } from 'three/webgpu';

export const rockMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });

const LIGHT = new Color('#a39a8c');
const DARK = new Color('#6f675d');
const tmp = new Color();

// All rocks of a chunk merged into one flat-shaded mesh.
export function createRocksMesh(rocks) {
  const triangles = rocks.reduce((n, r) => n + r.faces.length, 0);
  if (triangles === 0) return null;
  const positions = new Float32Array(triangles * 9);
  const colors = new Float32Array(triangles * 9);
  let o = 0;
  for (const rock of rocks) {
    tmp.copy(DARK).lerp(LIGHT, rock.tint);
    for (const face of rock.faces) {
      for (const vi of face) {
        positions[o] = rock.vertices[vi * 3];
        positions[o + 1] = rock.vertices[vi * 3 + 1];
        positions[o + 2] = rock.vertices[vi * 3 + 2];
        colors[o] = tmp.r;
        colors[o + 1] = tmp.g;
        colors[o + 2] = tmp.b;
        o += 3;
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new Mesh(geometry, rockMaterial);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
