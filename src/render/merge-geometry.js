import { BufferAttribute, BufferGeometry, Matrix3, Matrix4, Mesh, Vector3 } from 'three/webgpu';

const p = new Vector3();
const n = new Vector3();
const normalMatrix = new Matrix3();

// Merges geometries into one indexed BufferGeometry with positions and normals only, each with its
// transform baked in. parts: [{ geometry, matrix }].
export function mergeGeometries(parts) {
  let vertexCount = 0;
  let indexCount = 0;
  for (const { geometry } of parts) {
    const count = geometry.getAttribute('position').count;
    vertexCount += count;
    indexCount += geometry.index ? geometry.index.count : count;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  let vo = 0;
  let io = 0;
  for (const { geometry, matrix } of parts) {
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const pos = geometry.getAttribute('position');
    const nor = geometry.getAttribute('normal');
    normalMatrix.getNormalMatrix(matrix);
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      n.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
      const o = (vo + i) * 3;
      positions[o] = p.x;
      positions[o + 1] = p.y;
      positions[o + 2] = p.z;
      normals[o] = n.x;
      normals[o + 1] = n.y;
      normals[o + 2] = n.z;
    }
    // A mirroring transform turns triangles inside out; swap two corners to keep them facing out.
    const flip = matrix.determinant() < 0;
    const index = geometry.index;
    const count = index ? index.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      const a = index ? index.getX(i) : i;
      const b = index ? index.getX(i + 1) : i + 1;
      const c = index ? index.getX(i + 2) : i + 2;
      indices[io + i] = vo + a;
      indices[io + i + 1] = vo + (flip ? c : b);
      indices[io + i + 2] = vo + (flip ? b : c);
    }
    vo += pos.count;
    io += count;
  }
  const merged = new BufferGeometry();
  merged.setAttribute('position', new BufferAttribute(positions, 3));
  merged.setAttribute('normal', new BufferAttribute(normals, 3));
  merged.setIndex(new BufferAttribute(indices, 1));
  merged.computeBoundingSphere();
  return merged;
}

// Replaces every mesh under `root` (at any depth) with one merged mesh per material, as direct
// children of `root`, keeping their current poses relative to it. Only for parts that never move
// relative to `root`. A merged mesh casts or receives shadows if any of its parts did.
export function mergeByMaterial(root) {
  root.updateMatrixWorld(true);
  const toRoot = new Matrix4().copy(root.matrixWorld).invert();
  const byMaterial = new Map();
  root.traverse((object) => {
    if (!object.isMesh) return;
    let entry = byMaterial.get(object.material);
    if (!entry) byMaterial.set(object.material, (entry = { parts: [], castShadow: false, receiveShadow: false }));
    entry.parts.push({ geometry: object.geometry, matrix: new Matrix4().multiplyMatrices(toRoot, object.matrixWorld) });
    entry.castShadow ||= object.castShadow;
    entry.receiveShadow ||= object.receiveShadow;
  });
  for (const child of [...root.children]) root.remove(child);
  for (const [material, { parts, castShadow, receiveShadow }] of byMaterial) {
    const mesh = new Mesh(mergeGeometries(parts), material);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    root.add(mesh);
    for (const { geometry } of parts) geometry.dispose();
  }
  return root;
}
