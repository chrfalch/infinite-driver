// Draws the sunny town's props (terrain/props.js) around the car: one instanced mesh of crates, one
// of cones and one per yard kit model (render/yard-kit-mesh.js, made when first needed) for all
// chunks. Each prop stands where it was placed until physics
// reports it moving (apply), then follows its body. Chunks come and go as physics/props.js's do.
import { BoxGeometry, BufferAttribute, Color, ConeGeometry, CylinderGeometry, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CHUNK_SIZE, chunkKey } from '../terrain/chunk.js';
import { CONE, CRATE, generateProps, propHalfHeight } from '../terrain/props.js';
import { yardGeometries } from './yard-kit-mesh.js';
import { PROP_RADIUS, PROP_STRIDE } from '../physics/props.js';

const CAPACITY = 1500;
const YARD_CAPACITY = 600; // per yard model

const painted = (geometry, hex) => {
  const g = geometry.toNonIndexed();
  const c = new Color(hex);
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new BufferAttribute(colors, 3));
  return g;
};

// A slatted wooden crate (centred on its middle): a box with darker corner posts and bands.
function crateGeometry() {
  const s = CRATE;
  const parts = [painted(new BoxGeometry(s * 0.96, s * 0.96, s * 0.96), '#c08a52')];
  for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) parts.push(painted(new BoxGeometry(0.12, s, 0.12).translate((x * (s - 0.12)) / 2, 0, (z * (s - 0.12)) / 2), '#8a5a2e'));
  for (const y of [-1, 1]) {
    parts.push(painted(new BoxGeometry(s, 0.12, s * 0.98).translate(0, (y * (s - 0.12)) / 2, 0), '#8a5a2e'));
    parts.push(painted(new BoxGeometry(s * 0.98, 0.12, s).translate(0, (y * (s - 0.12)) / 2, 0), '#8a5a2e'));
  }
  return mergeGeometries(parts);
}

// A traffic cone (centred on its middle): orange with a white band, on a square foot.
function coneGeometry() {
  const h = CONE.height;
  const parts = [
    painted(new ConeGeometry(CONE.radius * 0.85, h * 0.92, 12).translate(0, 0.04, 0), '#f26a1b'),
    painted(new CylinderGeometry(CONE.radius * 0.42, CONE.radius * 0.55, h * 0.16, 12).translate(0, 0.02, 0), '#f4f4f0'),
    painted(new BoxGeometry(CONE.radius * 2.2, 0.05, CONE.radius * 2.2).translate(0, -h / 2 + 0.025, 0), '#e0561a'),
  ];
  return mergeGeometries(parts);
}

export function createPropsView(scene, heightAt) {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
  const meshes = {};
  const free = {};
  const addMesh = (kind, geometry, capacity) => {
    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = `props:${kind}`;
    meshes[kind] = mesh;
    free[kind] = [];
    scene.add(mesh);
    return mesh;
  };
  addMesh('crate', crateGeometry(), CAPACITY);
  addMesh('cone', coneGeometry(), CAPACITY);
  // A yard model's mesh, made the first time one is placed (null if the kit isn't loaded).
  const meshFor = (kind) => {
    if (meshes[kind]) return meshes[kind];
    const geometry = yardGeometries()?.get(kind);
    return geometry ? addMesh(kind, geometry, YARD_CAPACITY) : null;
  };
  const hidden = new Matrix4().makeScale(0, 0, 0);
  const chunks = new Map();
  const m = new Matrix4();
  const p = new Vector3();
  const q = new Quaternion();
  const one = new Vector3(1, 1, 1);

  const slot = (kind) => {
    const mesh = meshFor(kind);
    if (!mesh) return -1;
    if (free[kind].length) return free[kind].pop();
    if (mesh.count >= CAPACITY) return -1;
    return mesh.count++;
  };
  const place = (kind, index, x, y, z, qx, qy, qz, qw) => {
    if (index < 0) return;
    meshes[kind].setMatrixAt(index, m.compose(p.set(x, y, z), q.set(qx, qy, qz, qw), one));
    meshes[kind].instanceMatrix.needsUpdate = true;
  };

  function add(cx, cz) {
    const props = generateProps(heightAt, cx, cz).map((prop) => {
      const index = slot(prop.kind);
      const half = propHalfHeight(prop.kind);
      place(prop.kind, index, prop.x, prop.y + half, prop.z, 0, Math.sin(prop.yaw / 2), 0, Math.cos(prop.yaw / 2));
      return { kind: prop.kind, index };
    });
    chunks.set(chunkKey(cx, cz), { cx, cz, props });
  }

  function remove(key, c) {
    for (const { kind, index } of c.props) {
      if (index < 0) continue;
      meshes[kind].setMatrixAt(index, hidden);
      meshes[kind].instanceMatrix.needsUpdate = true;
      free[kind].push(index);
    }
    chunks.delete(key);
  }

  // The chunks around the car (as physics/props.js keeps them).
  function update(x, z) {
    const ccx = Math.floor(x / CHUNK_SIZE);
    const ccz = Math.floor(z / CHUNK_SIZE);
    for (const [key, c] of chunks) if (Math.abs(c.cx - ccx) > PROP_RADIUS + 1 || Math.abs(c.cz - ccz) > PROP_RADIUS + 1) remove(key, c);
    for (let dz = -PROP_RADIUS; dz <= PROP_RADIUS; dz++) {
      for (let dx = -PROP_RADIUS; dx <= PROP_RADIUS; dx++) if (!chunks.has(chunkKey(ccx + dx, ccz + dz))) add(ccx + dx, ccz + dz);
    }
  }

  // Poses of moving props, as physics/props.js's moved() lists them.
  function apply(poses) {
    if (!poses) return;
    for (let k = 0; k < poses.length; k += PROP_STRIDE) {
      const c = chunks.get(chunkKey(poses[k], poses[k + 1]));
      const prop = c?.props[poses[k + 2]];
      if (prop) place(prop.kind, prop.index, poses[k + 3], poses[k + 4], poses[k + 5], poses[k + 6], poses[k + 7], poses[k + 8], poses[k + 9]);
    }
  }

  return { update, apply, meshes };
}
