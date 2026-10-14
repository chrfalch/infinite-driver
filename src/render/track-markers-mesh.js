// Draws the dry river's course markers (terrain/track-markers.js) around the car: flags waving in
// the wind on white poles, yellow-and-black chevron boards on two posts, stacks of tyres, and the
// start gantry. One instanced mesh per part for all chunks; the flags' cloth waves in the vertex
// shader. Chunks come and go with the car, as the sunny town's props do (render/props-mesh.js).
import {
  BoxGeometry,
  BufferAttribute,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
} from 'three/webgpu';
import { instanceIndex, normalLocal, positionGeometry, positionLocal, sin, time, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CHUNK_SIZE, chunkKey } from '../terrain/chunk.js';
import { generateTrackMarkers } from '../terrain/track-markers.js';

const RADIUS = 3; // chunks each way of the car's
const CAPACITY = 1500;
const POLE = 2.1; // m
const CLOTH = { width: 0.62, height: 0.4 };
const FLAG_COLOURS = { 1: new Color('#d42a26'), [-1]: new Color('#f3c316') }; // left bank, right bank
const BOARD = { width: 1.5, height: 0.75, foot: 0.9 }; // m, its underside above the ground
const TYRE = { radius: 0.32, tube: 0.13 };
const TYRE_COLOURS = [new Color('#1d1d1e'), new Color('#efefea'), new Color('#c8251f')];

const painted = (geometry, hex) => {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const c = new Color(hex);
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new BufferAttribute(colors, 3));
  return g;
};

// A flag pole standing on its foot: white, with a red band at the bottom and a ball on top.
function poleGeometry() {
  return mergeGeometries([
    painted(new CylinderGeometry(0.02, 0.026, POLE, 8).translate(0, POLE / 2, 0), '#ecebe6'),
    painted(new CylinderGeometry(0.028, 0.028, 0.25, 8).translate(0, 0.27, 0), '#c8251f'),
    painted(new SphereGeometry(0.035, 8, 6).translate(0, POLE + 0.02, 0), '#d9d9d4'),
  ]);
}

// The flag's cloth, from the pole (x = 0) out along +x, at the top of the pole.
function clothGeometry() {
  return new PlaneGeometry(CLOTH.width, CLOTH.height, 10, 4).translate(CLOTH.width / 2, POLE - 0.05 - CLOTH.height / 2, 0);
}

// Waves the cloth: travelling ripples that grow from the pole to the free end, which also droops a
// little. Each flag (instance) has its own phase. (The material's position comes after the
// instance's pose, so the wave goes by the cloth's own x (positionGeometry) and moves it along its
// posed normal.)
function clothMaterial() {
  const material = new MeshStandardNodeMaterial({ side: DoubleSide, roughness: 0.85 });
  const x = positionGeometry.x;
  const out = x.div(CLOTH.width);
  const t = time.mul(6.5).add(instanceIndex.toFloat().mul(1.93));
  const wave = sin(t.sub(x.mul(9))).mul(0.06).add(sin(t.mul(0.53).sub(x.mul(4)).add(1.3)).mul(0.03));
  material.positionNode = positionLocal.add(normalLocal.mul(wave.mul(out))).add(vec3(0, out.mul(out).mul(-0.04), 0));
  return material;
}

// A canvas: the browser's, or an offscreen one.
function canvas(width, height) {
  if (globalThis.document) return Object.assign(document.createElement('canvas'), { width, height });
  return new OffscreenCanvas(width, height);
}

// The chevron board's face: three yellow arrows pointing to its +x on black, in a yellow frame.
function chevronTexture() {
  const c = canvas(256, 128);
  const g = c.getContext('2d');
  g.fillStyle = '#141414';
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#f6c81b';
  for (let i = 0; i < 3; i++) {
    const x = 40 + i * 66;
    g.beginPath();
    g.moveTo(x, 18);
    g.lineTo(x + 26, 18);
    g.lineTo(x + 62, 64);
    g.lineTo(x + 26, 110);
    g.lineTo(x, 110);
    g.lineTo(x + 36, 64);
    g.closePath();
    g.fill();
  }
  g.lineWidth = 10;
  g.strokeStyle = '#f6c81b';
  g.strokeRect(5, 5, 246, 118);
  const texture = new CanvasTexture(c);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// The start banner: a checkered band either side of START.
function bannerTexture() {
  const c = canvas(1024, 128);
  const g = c.getContext('2d');
  g.fillStyle = '#f4f2ea';
  g.fillRect(0, 0, 1024, 128);
  const cell = 32;
  for (const x0 of [0, 1024 - 8 * cell]) {
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 8; i++) {
        if ((i + j) % 2) continue;
        g.fillStyle = '#151515';
        g.fillRect(x0 + i * cell, j * cell, cell, cell);
      }
    }
  }
  g.fillStyle = '#c8251f';
  g.font = 'bold 92px Inter, Helvetica, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('START', 512, 68);
  const texture = new CanvasTexture(c);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// The start gantry, with its middle at the origin and the banner across +x: two lattice towers
// standing on their own ground (feet: left, right) up to the banner's top, and the banner between.
function createGantry(mark) {
  const group = new Group();
  const steel = new MeshStandardMaterial({ color: '#b9bcbf', roughness: 0.45, metalness: 0.6 });
  const top = mark.top + 1.2 - mark.y; // the banner's top, above the gantry's origin
  mark.feet.forEach((foot, i) => {
    const sx = (i ? 1 : -1) * mark.half;
    const base = foot - mark.y - 0.3; // a little into the ground
    const tall = top + 0.3 - base;
    const tower = new Group();
    for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) tower.add(new Mesh(new BoxGeometry(0.07, tall, 0.07).translate(dx * 0.22, base + tall / 2, dz * 0.22), steel));
    // Cross braces every metre or so.
    for (let y = base + 0.6; y < base + tall - 0.3; y += 1.1) {
      for (const dz of [-1, 1]) tower.add(new Mesh(new BoxGeometry(0.5, 0.05, 0.05).translate(0, y, dz * 0.22), steel));
      for (const dx of [-1, 1]) tower.add(new Mesh(new BoxGeometry(0.05, 0.05, 0.5).translate(dx * 0.22, y, 0), steel));
    }
    tower.position.x = sx;
    group.add(tower);
  });
  const span = 2 * mark.half;
  const banner = new Mesh(new BoxGeometry(span - 0.5, 1.1, 0.08).translate(0, top - 0.55, 0), [steel, steel, steel, steel, new MeshStandardMaterial({ map: bannerTexture(), roughness: 0.8 }), new MeshStandardMaterial({ map: bannerTexture(), roughness: 0.8 })]);
  group.add(banner);
  // A truss along its top.
  group.add(new Mesh(new BoxGeometry(span + 0.5, 0.12, 0.12).translate(0, top + 0.06, 0), steel));
  group.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
  });
  group.position.set(mark.x, mark.y, mark.z);
  group.rotation.y = mark.yaw;
  group.name = 'track:gantry';
  return group;
}

export function createTrackMarkersView(scene, heightAt) {
  const plain = new MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
  const rubber = new MeshStandardMaterial({ roughness: 0.92 });
  const board = new MeshStandardMaterial({ map: chevronTexture(), emissive: '#ffffff', roughness: 0.55, side: DoubleSide });
  // (A faint glow of its own, like retroreflective film in the headlights.)
  board.emissiveMap = board.map;
  board.emissiveIntensity = 0.12;
  const meshes = {
    pole: new InstancedMesh(poleGeometry(), plain, CAPACITY),
    cloth: new InstancedMesh(clothGeometry(), clothMaterial(), CAPACITY),
    post: new InstancedMesh(painted(new BoxGeometry(0.08, BOARD.foot + BOARD.height + 0.1, 0.08).translate(0, (BOARD.foot + BOARD.height + 0.1) / 2 - 0.1, 0), '#5c5f62'), plain, CAPACITY),
    board: new InstancedMesh(new PlaneGeometry(BOARD.width, BOARD.height).translate(0, BOARD.foot + BOARD.height / 2, 0.05), board, CAPACITY),
    tyre: new InstancedMesh(new TorusGeometry(TYRE.radius, TYRE.tube, 8, 18).rotateX(Math.PI / 2), rubber, CAPACITY),
  };
  const free = {};
  for (const [part, mesh] of Object.entries(meshes)) {
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = `track:${part}`;
    free[part] = [];
    scene.add(mesh);
  }
  const hidden = new Matrix4().makeScale(0, 0, 0);
  const chunks = new Map();
  const m = new Matrix4();
  const p = new Vector3();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const scale = new Vector3();

  // Takes an instance of `part` posed at (x, y, z) turned by yaw, and records it in `taken`.
  const put = (taken, part, x, y, z, yaw, colour, sx = 1) => {
    const mesh = meshes[part];
    const index = free[part].length ? free[part].pop() : mesh.count < CAPACITY ? mesh.count++ : -1;
    if (index < 0) return;
    mesh.setMatrixAt(index, m.compose(p.set(x, y, z), q.setFromAxisAngle(up, yaw), scale.set(sx, 1, 1)));
    mesh.instanceMatrix.needsUpdate = true;
    if (colour) {
      mesh.setColorAt(index, colour);
      mesh.instanceColor.needsUpdate = true;
    }
    taken.push([part, index]);
  };

  function add(cx, cz) {
    const taken = [];
    const groups = [];
    for (const mark of generateTrackMarkers(heightAt, cx, cz)) {
      const { x, y, z, yaw } = mark;
      if (mark.kind === 'flag') {
        put(taken, 'pole', x, y - 0.15, z, yaw);
        put(taken, 'cloth', x, y - 0.15, z, yaw, FLAG_COLOURS[mark.side]);
      } else if (mark.kind === 'chevron') {
        const c = Math.cos(yaw);
        const s = Math.sin(yaw);
        for (const side of [-1, 1]) {
          const px = x + c * side * BOARD.width * 0.38;
          const pz = z - s * side * BOARD.width * 0.38;
          put(taken, 'post', px, heightAt(px, pz), pz, yaw);
        }
        put(taken, 'board', x, y, z, yaw, null, mark.flip ? -1 : 1);
      } else if (mark.kind === 'tyres') {
        for (let i = 0; i < mark.high; i++) {
          const top = i === mark.high - 1;
          put(taken, 'tyre', x, y - 0.06 + TYRE.tube + i * TYRE.tube * 1.9, z, yaw + i, TYRE_COLOURS[top ? 1 + (Math.round(yaw * 10) % 2) : 0]);
        }
      } else if (mark.kind === 'gantry') {
        const gantry = createGantry(mark);
        gantry.updateMatrixWorld(true);
        scene.add(gantry);
        groups.push(gantry);
      }
    }
    chunks.set(chunkKey(cx, cz), { cx, cz, taken, groups });
  }

  function remove(key, c) {
    for (const [part, index] of c.taken) {
      meshes[part].setMatrixAt(index, hidden);
      meshes[part].instanceMatrix.needsUpdate = true;
      free[part].push(index);
    }
    for (const g of c.groups) scene.remove(g);
    chunks.delete(key);
  }

  // The chunks around the car.
  function update(x, z) {
    const ccx = Math.floor(x / CHUNK_SIZE);
    const ccz = Math.floor(z / CHUNK_SIZE);
    for (const [key, c] of chunks) if (Math.abs(c.cx - ccx) > RADIUS + 1 || Math.abs(c.cz - ccz) > RADIUS + 1) remove(key, c);
    for (let dz = -RADIUS; dz <= RADIUS; dz++) {
      for (let dx = -RADIUS; dx <= RADIUS; dx++) if (!chunks.has(chunkKey(ccx + dx, ccz + dz))) add(ccx + dx, ccz + dz);
    }
  }

  return { update, meshes };
}
