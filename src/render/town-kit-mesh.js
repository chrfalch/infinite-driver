// The sunny town's buildings, modelled in Blender (scripts/town-kit/build_kit.py) and loaded from
// public/models/town-kit.glb: a corner block with a turret, a house under a bell-curved mansard,
// a cottage, a domed tower and a Dutch-gabled row, listed in terrain/town-kit.js. Each lot of
// terrain/buildings.js names its model; a chunk's are copied, turned to face their streets, into
// one mesh (one draw call per chunk, like the dark town's).
//
// Model frame (glTF): y up, the front facing +z, the origin on the ground in the middle of the
// footprint. A building's frame: x along its street (ux, uz), the front toward the street (-nx, -nz).
import { BufferAttribute, BufferGeometry, Color, Mesh } from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TOWN_KIT } from '../terrain/town-kit.js';
import { WALLS } from '../terrain/buildings.js';
import { kitBuildingMaterial } from './building-mesh.js';

const MODEL_URL = () => `${(typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/'}models/town-kit.glb`;

// Per kit name: { positions, normals, colors, glass, wall, index } in the model's frame (`wall`:
// 1 on the main walls, which each building repaints).
let prototypes = null;
let loading = null;

// Loads the kit once (the world waits for it before its first chunk).
export function loadTownKit() {
  loading ??= new GLTFLoader().loadAsync(MODEL_URL()).then((gltf) => {
    prototypes = prototypesFrom(gltf.scene);
    return prototypes;
  });
  return loading;
}

// The kit's meshes as plain arrays, by name (exported for the tests).
export function prototypesFrom(scene) {
  scene.updateMatrixWorld(true);
  const out = new Map();
  for (const { name } of TOWN_KIT) {
    const root = scene.getObjectByName(name);
    if (!root) throw new Error(`town kit: no model named ${name}`);
    const parts = [];
    root.traverse((o) => {
      if (o.isMesh) parts.push(o);
    });
    out.set(name, mergeParts(parts));
  }
  return out;
}

function mergeParts(parts) {
  let vertices = 0;
  let indices = 0;
  for (const m of parts) {
    vertices += m.geometry.attributes.position.count;
    indices += m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count;
  }
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const colors = new Float32Array(vertices * 3);
  const glass = new Float32Array(vertices);
  const wall = new Uint8Array(vertices);
  const index = new Uint32Array(indices);
  let v = 0;
  let k = 0;
  const p = { x: 0, y: 0, z: 0 };
  for (const m of parts) {
    const g = m.geometry;
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    const col = g.attributes.color;
    const isGlass = /glass/i.test(m.material?.name ?? '') ? 1 : 0;
    const e = m.matrixWorld.elements;
    for (let i = 0; i < pos.count; i++) {
      p.x = pos.getX(i);
      p.y = pos.getY(i);
      p.z = pos.getZ(i);
      const o = (v + i) * 3;
      positions[o] = e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12];
      positions[o + 1] = e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13];
      positions[o + 2] = e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14];
      const nx = nor.getX(i);
      const ny = nor.getY(i);
      const nz = nor.getZ(i);
      normals[o] = e[0] * nx + e[4] * ny + e[8] * nz;
      normals[o + 1] = e[1] * nx + e[5] * ny + e[9] * nz;
      normals[o + 2] = e[2] * nx + e[6] * ny + e[10] * nz;
      if (col) {
        colors[o] = col.getX(i);
        colors[o + 1] = col.getY(i);
        colors[o + 2] = col.getZ(i);
        // The main walls are marked by half alpha (see scripts/town-kit/build_kit.py).
        wall[v + i] = col.itemSize === 4 && col.getW(i) < 0.75 ? 1 : 0;
      } else colors.fill(1, o, o + 3);
      glass[v + i] = isGlass;
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) index[k++] = g.index.getX(i) + v;
    else for (let i = 0; i < pos.count; i++) index[k++] = i + v;
    v += pos.count;
  }
  return { positions, normals, colors, glass, wall, index };
}

const KEEP = 0.35; // share of buildings in their model's own wall colour
const wallColor = new Color();

// The kit buildings among a chunk's rocks as one mesh (null if there are none, or the kit has not
// loaded).
export function createKitBuildingsMesh(rocks, kit = prototypes) {
  if (!kit) return null;
  const placed = [];
  let vertices = 0;
  let indices = 0;
  for (const rock of rocks) {
    const b = rock.building;
    const proto = b?.kit && kit.get(b.kit);
    if (!proto) continue;
    placed.push([b, proto]);
    vertices += proto.glass.length;
    indices += proto.index.length;
  }
  if (!placed.length) return null;
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const colors = new Float32Array(vertices * 3);
  const glass = new Float32Array(vertices);
  const index = new Uint32Array(indices);
  let v = 0;
  let k = 0;
  for (const [b, proto] of placed) {
    // Model x -> along the street, y -> up, z (its front) -> toward the street.
    const ax = b.ux;
    const az = b.uz;
    const fx = -b.nx;
    const fz = -b.nz;
    const n = proto.glass.length;
    for (let i = 0; i < n; i++) {
      const s = i * 3;
      const o = (v + i) * 3;
      const px = proto.positions[s];
      const pz = proto.positions[s + 2];
      positions[o] = b.x + ax * px + fx * pz;
      positions[o + 1] = b.ground + proto.positions[s + 1];
      positions[o + 2] = b.z + az * px + fz * pz;
      const nx = proto.normals[s];
      const nz = proto.normals[s + 2];
      normals[o] = ax * nx + fx * nz;
      normals[o + 1] = proto.normals[s + 1];
      normals[o + 2] = az * nx + fz * nz;
    }
    colors.set(proto.colors, v * 3);
    // Some buildings keep their model's wall colour, the rest are painted from the town's palette.
    if (b.wall >= KEEP) {
      wallColor.set(WALLS[Math.floor(((b.wall - KEEP) / (1 - KEEP)) * WALLS.length) % WALLS.length]).offsetHSL(0, 0, (b.extra - 0.5) * 0.06);
      for (let i = 0; i < n; i++) {
        if (!proto.wall[i]) continue;
        const o = (v + i) * 3;
        colors[o] = wallColor.r;
        colors[o + 1] = wallColor.g;
        colors[o + 2] = wallColor.b;
      }
    }
    glass.set(proto.glass, v);
    for (let i = 0; i < proto.index.length; i++) index[k++] = proto.index[i] + v;
    v += n;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('glass', new BufferAttribute(glass, 1));
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  const mesh = new Mesh(geometry, kitBuildingMaterial);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'kit buildings';
  return mesh;
}
