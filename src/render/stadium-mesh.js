// Draws the stadium's fixtures (terrain/stadium.js): the red-and-white rails along the lanes, the
// arena's concrete wall, the start gantry with its chequered banner, and the grandstands round the
// arena packed with a crowd. All of it is still and the arena small, so it is built once: one
// instanced mesh per part, never culled or moved.
import { BoxGeometry, CanvasTexture, Color, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, NearestFilter, Quaternion, SRGBColorSpace, Vector3 } from 'three/webgpu';
import { BARRIER } from '../terrain/stadium.js';
import { mulberry32 } from '../terrain/height.js';

const RAIL_COLOURS = [new Color('#d0262a'), new Color('#efeeea')];
const WALL_COLOUR = new Color('#b9b6ae');
const WALL_BAND = new Color('#2a5fb0'); // a blue band along the wall's top
const STAND = { rows: 12, depth: 0.85, rise: 0.48, gap: 2.5 }; // terraces, m
const STAND_CONCRETE = new Color('#8f8c86');
const SHIRTS = ['#d23c33', '#f2f0ea', '#2f5fae', '#f0c330', '#2a2a2e', '#3f8f4a', '#e07a2e', '#8a4fa6', '#6fb5e0'].map((c) => new Color(c));
const SINK = 0.3; // m below the ground, as physics/barriers.js

// A black-and-white chequered banner texture.
function chequerTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 4;
  const ctx = canvas.getContext('2d');
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 4; j++) {
      ctx.fillStyle = (i + j) % 2 ? '#111' : '#f4f4f0';
      ctx.fillRect(i, j, 1, 1);
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.magFilter = NearestFilter;
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export function createStadiumView(scene, heightAt) {
  const m = new Matrix4();
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  const up = new Vector3(0, 1, 0);
  const box = new BoxGeometry(1, 1, 1);
  const made = [];
  const instanced = (name, count, material, shadows = true) => {
    const mesh = new InstancedMesh(box, material, count);
    mesh.name = `stadium:${name}`;
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    scene.add(mesh);
    made.push(mesh);
    return mesh;
  };

  // Rails and wall: each piece a box from below the ground up to its height.
  const rails = heightAt.barriers.filter((b) => b.kind === 'rail');
  const walls = heightAt.barriers.filter((b) => b.kind === 'wall');
  const railMesh = instanced('rails', rails.length, new MeshStandardMaterial({ roughness: 0.5 }));
  rails.forEach((b, i) => {
    const base = heightAt(b.x, b.z) - SINK;
    m.compose(p.set(b.x, base + (b.height + SINK) / 2, b.z), q.setFromAxisAngle(up, b.yaw), s.set(b.length, b.height + SINK, b.thick));
    railMesh.setMatrixAt(i, m);
    railMesh.setColorAt(i, RAIL_COLOURS[b.stripe]);
  });
  const wallMesh = instanced('wall', walls.length * 2, new MeshStandardMaterial({ roughness: 0.85 }));
  walls.forEach((b, i) => {
    const base = heightAt(b.x, b.z) - SINK;
    const body = b.height - 0.35;
    m.compose(p.set(b.x, base + (body + SINK) / 2, b.z), q.setFromAxisAngle(up, b.yaw), s.set(b.length, body + SINK, b.thick));
    wallMesh.setMatrixAt(2 * i, m);
    wallMesh.setColorAt(2 * i, WALL_COLOUR);
    m.compose(p.set(b.x, base + SINK + body + 0.175, b.z), q.setFromAxisAngle(up, b.yaw), s.set(b.length, 0.35, b.thick + 0.04));
    wallMesh.setMatrixAt(2 * i + 1, m);
    wallMesh.setColorAt(2 * i + 1, WALL_BAND);
  });

  // Grandstands on all four sides, behind the wall: terraces of concrete with a crowd on each, one
  // box per spectator's width in a shirt colour of their own.
  const { x0, x1, z0, z1 } = heightAt.arena;
  const rand = mulberry32(9);
  const seat = 0.9; // m of terrace per spectator
  const sides = [
    { ax: x0, az: z0, bx: x1, bz: z0, ox: 0, oz: -1 },
    { ax: x1, az: z0, bx: x1, bz: z1, ox: 1, oz: 0 },
    { ax: x1, az: z1, bx: x0, bz: z1, ox: 0, oz: 1 },
    { ax: x0, az: z1, bx: x0, bz: z0, ox: -1, oz: 0 },
  ];
  let people = 0;
  for (const side of sides) people += STAND.rows * Math.floor(Math.hypot(side.bx - side.ax, side.bz - side.az) / seat);
  const terraceMesh = instanced('terraces', sides.length * STAND.rows, new MeshStandardMaterial({ roughness: 0.9 }));
  const crowdMesh = instanced('crowd', people, new MeshStandardMaterial({ roughness: 0.95 }), false);
  let t = 0;
  let c = 0;
  for (const side of sides) {
    const length = Math.hypot(side.bx - side.ax, side.bz - side.az);
    const tx = (side.bx - side.ax) / length;
    const tz = (side.bz - side.az) / length;
    const yaw = Math.atan2(-tz, tx);
    const mx = (side.ax + side.bx) / 2;
    const mz = (side.az + side.bz) / 2;
    for (let row = 0; row < STAND.rows; row++) {
      const out = STAND.gap + (row + 0.5) * STAND.depth;
      const top = (row + 1) * STAND.rise;
      // Each terrace runs the side's length plus the stands' depth either end, so the corners close.
      const span = length + 2 * (STAND.gap + STAND.rows * STAND.depth);
      m.compose(p.set(mx + side.ox * out, top / 2, mz + side.oz * out), q.setFromAxisAngle(up, yaw), s.set(span, top, STAND.depth));
      terraceMesh.setMatrixAt(t, m);
      terraceMesh.setColorAt(t++, STAND_CONCRETE);
      const n = Math.floor(length / seat);
      for (let k = 0; k < n; k++) {
        const along = (k + 0.5) * seat - length / 2 + (rand() - 0.5) * 0.2;
        const tall = 0.75 + rand() * 0.3;
        const where = out + (rand() - 0.5) * 0.2;
        m.compose(p.set(mx + tx * along + side.ox * where, top + tall / 2, mz + tz * along + side.oz * where), q.setFromAxisAngle(up, yaw + (rand() - 0.5) * 0.4), s.set(0.5, tall, 0.35));
        crowdMesh.setMatrixAt(c, m);
        crowdMesh.setColorAt(c++, SHIRTS[Math.floor(rand() * SHIRTS.length)]);
      }
    }
  }

  // The start gantry over the origin: two posts outside the rails and a chequered banner across.
  const clear = 4.2; // m from the ground to the banner's underside
  const reach = BARRIER.offset + 0.6;
  const steel = new MeshStandardMaterial({ color: '#5c5f62', roughness: 0.5, metalness: 0.4 });
  const gantry = [];
  for (const side of [-1, 1]) {
    const post = new Mesh(new BoxGeometry(0.25, clear + 0.9, 0.25), steel);
    post.position.set(0, (clear + 0.9) / 2, side * reach);
    gantry.push(post);
  }
  const banner = new Mesh(new BoxGeometry(0.12, 0.9, 2 * reach), new MeshStandardMaterial({ map: chequerTexture(), roughness: 0.7 }));
  banner.position.set(0, clear + 0.45, 0);
  gantry.push(banner);
  for (const part of gantry) {
    part.name = 'stadium:gantry';
    part.castShadow = true;
    part.receiveShadow = true;
    scene.add(part);
    made.push(part);
  }

  return {
    meshes: made,
    dispose() {
      for (const mesh of made) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      }
    },
  };
}
