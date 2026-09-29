// The dry river's pebbles (terrain/rocks.js generatePebbles): one instanced, flat-shaded
// icosahedron per pebble, the same shape as the stones the tyres throw (render/soil-particles.js).
import { Color, IcosahedronGeometry, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three/webgpu';
import { PEBBLE_STRIDE } from '../terrain/rocks.js';

const geometry = new IcosahedronGeometry(1, 0);
const material = new MeshStandardMaterial({ roughness: 1, metalness: 0, flatShading: true });
const LIGHT = new Color('#d6c29a');
const DARK = new Color('#7d6c52');
const GREY = new Color('#9c978d');
const RED = new Color('#a8683f');
const m4 = new Matrix4();
const q = new Quaternion();
const up = new Vector3(0, 1, 0);
const pos = new Vector3();
const scale = new Vector3();
const color = new Color();

export function createPebbleMesh(data) {
  if (!data) return null;
  const count = data.length / PEBBLE_STRIDE;
  const mesh = new InstancedMesh(geometry, material, count);
  for (let i = 0; i < count; i++) {
    const [x, y, z, yaw, size, squash, tint, grey] = data.subarray(i * PEBBLE_STRIDE, (i + 1) * PEBBLE_STRIDE);
    q.setFromAxisAngle(up, yaw);
    m4.compose(pos.set(x, y + size * squash * 0.5, z), q, scale.set(size * (0.8 + 0.4 * tint), size * squash, size));
    mesh.setMatrixAt(i, m4);
    color.copy(DARK).lerp(LIGHT, tint).lerp(GREY, grey * 0.6);
    if (grey > 0.92) color.lerp(RED, 0.6);
    mesh.setColorAt(i, color);
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  mesh.name = 'pebbles';
  return mesh;
}
