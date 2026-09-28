// Low-poly cartoon bushes and small trees (juniper-like), one instanced mesh per part per chunk.
import {
  Color,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  BufferAttribute,
  Mesh,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// A lumpy bush: three squashed icosahedra.
function bushGeometry() {
  const parts = [
    [0, 0.45, 0, 0.62],
    [0.38, 0.32, 0.12, 0.45],
    [-0.3, 0.3, -0.22, 0.48],
  ].map(([x, y, z, r]) => new IcosahedronGeometry(r, 1).scale(1, 0.8, 1).translate(x, y, z));
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

// Gum tree (eucalypt), unit height: a tall, slightly kinked pale trunk that forks into a few
// limbs, and an open crown of small flattened leaf clumps spread wide at the top.
function limb(x0, y0, z0, x1, y1, z1, r0, r1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz);
  const g = new CylinderGeometry(r1, r0, len, 6).translate(0, len / 2, 0);
  const dir = new Vector3(dx, dy, dz).normalize();
  g.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir));
  return g.translate(x0, y0, z0).toNonIndexed();
}
function gumTrunkGeometry() {
  return mergeGeometries([
    limb(0, -0.02, 0, 0.02, 0.36, 0.01, 0.026, 0.019),
    limb(0.02, 0.35, 0.01, -0.01, 0.58, 0.02, 0.019, 0.013),
    limb(0.015, 0.45, 0.012, 0.16, 0.7, 0.04, 0.011, 0.006),
    limb(0.0, 0.5, 0.015, -0.14, 0.72, -0.08, 0.01, 0.005),
    limb(-0.01, 0.57, 0.02, 0.04, 0.86, -0.1, 0.009, 0.005),
    limb(-0.01, 0.56, 0.02, -0.05, 0.9, 0.1, 0.008, 0.004),
  ]);
}
function gumCrownGeometry() {
  const parts = [
    [0.17, 0.72, 0.05, 0.12],
    [-0.15, 0.74, -0.09, 0.13],
    [0.03, 0.8, 0.0, 0.14],
    [0.05, 0.9, -0.12, 0.11],
    [-0.06, 0.94, 0.11, 0.1],
    [0.23, 0.82, -0.07, 0.09],
    [-0.22, 0.84, 0.05, 0.08],
    [0.1, 1.0, 0.06, 0.08],
  ].map(([x, y, z, r]) => new IcosahedronGeometry(r, 0).scale(1.25, 0.55, 1.25).translate(x, y, z));
  return mergeGeometries(parts);
}
const GUM_TRUNK = gumTrunkGeometry();
const GUM_CROWN = gumCrownGeometry();
const leaves = new MeshStandardMaterial({ roughness: 0.9, flatShading: true });
const bark = new MeshStandardMaterial({ color: '#6b4a32', roughness: 0.95, flatShading: true });
// Pale gum bark: white material, tinted per tree (cream, grey, pinkish) by the instance colour.
const gumBark = new MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, flatShading: true });
// A bush the car has touched gets its own mesh (a copy of the bush geometry, deformed on the CPU):
// only the parts under a wheel go flat onto the ground and the parts under the belly are pressed
// down; the rest keeps its shape. See systems/vegetation.js.
export function createCrushedBush(mesh, index) {
  const geometry = BUSH.clone();
  const material = mesh.material;
  const bush = new Mesh(geometry, material);
  bush.castShadow = true;
  bush.receiveShadow = true;
  mesh.getMatrixAt(index, bush.matrix);
  bush.matrixAutoUpdate = false;
  const colour = new Color();
  mesh.getColorAt(index, colour);
  const colours = new Float32Array(geometry.attributes.position.count * 3);
  for (let i = 0; i < colours.length; i += 3) colours.set([colour.r, colour.g, colour.b], i);
  geometry.setAttribute('color', new BufferAttribute(colours, 3));
  bush.material = crushedLeaves;
  bush.userData.rest = Float32Array.from(geometry.attributes.position.array);
  // Hide the instance.
  mesh.setMatrixAt(index, new Matrix4().makeScale(0, 0, 0));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.parent.add(bush);
  return bush;
}
const crushedLeaves = new MeshStandardMaterial({ roughness: 0.9, flatShading: true, vertexColors: true });

// Deforms a crushed bush: `strips` are wheel paths in the bush's local frame ({ x, z, dx, dz,
// amount, width }), `belly` the local height tops are pressed down to, `floor(x, z)` the local
// ground height.
export function deformBush(bush, strips, belly, floor) {
  const rest = bush.userData.rest;
  const pos = bush.geometry.attributes.position;
  const out = pos.array;
  for (let i = 0; i < rest.length; i += 3) {
    let x = rest[i];
    let y = rest[i + 1];
    let z = rest[i + 2];
    const f = floor(x, z);
    let flat = 0;
    let sx = 0;
    let sz = 0;
    for (const s of strips) {
      const side = (x - s.x) * s.dz - (z - s.z) * s.dx;
      const d = Math.abs(side);
      const t = Math.min(1, Math.max(0, (d - s.width * 0.7) / s.width));
      const w = (1 - t * t * (3 - 2 * t)) * s.amount;
      if (w > flat) flat = w;
      const push = Math.sign(side) * w * 0.14;
      sx += s.dz * push;
      sz -= s.dx * push;
    }
    const flatY = f + (y - f) * 0.08 + 0.02;
    y = y + (Math.min(y, flatY) - y) * flat;
    y = Math.min(y, Math.max(belly, f + 0.03));
    out[i] = x + sx;
    out[i + 1] = y;
    out[i + 2] = z + sz;
  }
  pos.needsUpdate = true;
  bush.geometry.computeVertexNormals();
  bush.geometry.computeBoundingSphere();
}

const GREENS = ['#6f8f3a', '#86a147', '#5f7d33', '#98a95a', '#7a8a45'].map((c) => new Color(c));
// Grey-green eucalypt and saltbush leaves, and gum bark tints.
const GUM_GREENS = ['#7d8f68', '#8e9c74', '#6c7e5a', '#9aa47e', '#768660'].map((c) => new Color(c));
const GUM_BARK = ['#e4dccb', '#cfc8ba', '#d9c3b0', '#bdb6a6'].map((c) => new Color(c));
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
  const trees = plants.filter((p) => p.kind === 'tree' && !p.gum);
  const gums = plants.filter((p) => p.gum);
  const group = new Group();
  const instanced = (geometry, material, count) => {
    const mesh = new InstancedMesh(geometry, material, count);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const colour = (p, i, mesh) => {
    const greens = p.gum || p.grey ? GUM_GREENS : GREENS;
    col.copy(greens[Math.floor(p.shade * greens.length) % greens.length]);
    if (p.shade > 0.85) col.lerp(DRY, 0.5);
    mesh.setColorAt(i, col);
  };
  if (bushes.length) {
    const mesh = instanced(BUSH, leaves, bushes.length);
    group.userData.bushes = { mesh, plants: bushes, crushed: new Map() };
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
  if (gums.length) {
    const trunks = instanced(GUM_TRUNK, gumBark, gums.length);
    const crowns = instanced(GUM_CROWN, leaves, gums.length);
    gums.forEach((p, i) => {
      q.setFromAxisAngle(up, p.turn);
      m.compose(pos.set(p.x, p.y - 0.1, p.z), q, scl.set(p.height, p.height, p.height));
      trunks.setMatrixAt(i, m);
      crowns.setMatrixAt(i, m);
      trunks.setColorAt(i, GUM_BARK[Math.floor(p.shade * 7) % GUM_BARK.length]);
      colour(p, i, crowns);
    });
  }
  for (const child of group.children) child.computeBoundingSphere();
  return group;
}
