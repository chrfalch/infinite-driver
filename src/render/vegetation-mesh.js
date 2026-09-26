// Low-poly cartoon bushes and small trees (juniper-like), one instanced mesh per part per chunk.
import {
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { attribute, clamp, positionLocal, vec3 } from 'three/tsl';

// A lumpy bush: three squashed icosahedra.
function bushGeometry() {
  const parts = [
    [0, 0.45, 0, 0.62],
    [0.38, 0.32, 0.12, 0.45],
    [-0.3, 0.3, -0.22, 0.48],
  ].map(([x, y, z, r]) => new IcosahedronGeometry(r, 0).scale(1, 0.8, 1).translate(x, y, z));
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}

// Tree crown: stacked lumps above a unit-height trunk.
function crownGeometry() {
  const parts = [
    [0, 0.62, 0, 0.36],
    [0.16, 0.8, 0.06, 0.28],
    [-0.1, 0.9, -0.08, 0.26],
    [0.02, 1.02, 0.02, 0.2],
  ].map(([x, y, z, r]) => new IcosahedronGeometry(r, 0).translate(x, y, z));
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}

const BUSH = bushGeometry();
const CROWN = crownGeometry();
const TRUNK = new CylinderGeometry(0.035, 0.06, 0.62, 6).translate(0, 0.31, 0);
const leaves = new MeshStandardMaterial({ roughness: 0.9, flatShading: true });
const bark = new MeshStandardMaterial({ color: '#6b4a32', roughness: 0.95, flatShading: true });
// Bushes bend and squash where the car drives over them. Per instance, `bend` holds the push
// direction in the bush's own frame (x, z) and the amount (0..1); the vertex shader leans the bush
// over and flattens it, more toward the top. systems/vegetation.js drives the values.
const bushLeaves = new MeshStandardNodeMaterial({ roughness: 0.9, flatShading: true });
bushLeaves.positionNode = (() => {
  const bend = attribute('bend', 'vec3');
  const p = positionLocal;
  const h = clamp(p.y.div(0.9), 0, 1);
  const amount = bend.z.mul(h);
  return vec3(p.x.add(bend.x.mul(amount).mul(0.55)), p.y.mul(bend.z.mul(-0.72).add(1)), p.z.add(bend.y.mul(amount).mul(0.55)));
})();

const GREENS = ['#6f8f3a', '#86a147', '#5f7d33', '#98a95a', '#7a8a45'].map((c) => new Color(c));
const DRY = new Color('#a39a5a');
const m = new Matrix4();
const q = new Quaternion();
const up = new Vector3(0, 1, 0);
const pos = new Vector3();
const scl = new Vector3();
const col = new Color();

export function createVegetationMesh(plants) {
  if (!plants.length) return null;
  const bushes = plants.filter((p) => p.kind === 'bush');
  const trees = plants.filter((p) => p.kind === 'tree');
  const group = new Group();
  const instanced = (geometry, material, count) => {
    const mesh = new InstancedMesh(geometry, material, count);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const colour = (p, i, mesh) => {
    col.copy(GREENS[Math.floor(p.shade * GREENS.length) % GREENS.length]);
    if (p.shade > 0.85) col.lerp(DRY, 0.5);
    mesh.setColorAt(i, col);
  };
  if (bushes.length) {
    const mesh = instanced(BUSH.clone(), bushLeaves, bushes.length);
    const bend = new InstancedBufferAttribute(new Float32Array(bushes.length * 3), 3);
    bend.setUsage(DynamicDrawUsage);
    mesh.geometry.setAttribute('bend', bend);
    group.userData.bushes = { mesh, plants: bushes, bend, amount: new Float32Array(bushes.length), active: new Set() };
    bushes.forEach((p, i) => {
      q.setFromAxisAngle(up, p.turn);
      m.compose(pos.set(p.x, p.y - 0.08, p.z), q, scl.set(p.size, p.size * (0.8 + p.shade * 0.4), p.size));
      mesh.setMatrixAt(i, m);
      colour(p, i, mesh);
    });
  }
  if (trees.length) {
    const trunks = instanced(TRUNK, bark, trees.length);
    const crowns = instanced(CROWN, leaves, trees.length);
    trees.forEach((p, i) => {
      q.setFromAxisAngle(up, p.turn);
      m.compose(pos.set(p.x, p.y - 0.05, p.z), q, scl.set(p.height, p.height, p.height));
      trunks.setMatrixAt(i, m);
      crowns.setMatrixAt(i, m);
      colour(p, i, crowns);
    });
  }
  for (const child of group.children) child.computeBoundingSphere();
  return group;
}
