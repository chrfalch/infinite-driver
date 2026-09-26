import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three/webgpu';
import { CAR } from '../vehicle/config.js';
import { frameGeometry, suspensionMounts } from '../vehicle/frame-geometry.js';
import { mergeByMaterial } from './merge-geometry.js';

export const cagePaint = new MeshStandardMaterial({ color: '#d9683f', roughness: 0.45, metalness: 0.25 });
const frameMat = new MeshStandardMaterial({ color: '#2d2f31', roughness: 0.65, metalness: 0.35 });
const plateMat = new MeshStandardMaterial({ color: '#3a3c3e', roughness: 0.6, metalness: 0.4 });
const bracketMat = new MeshStandardMaterial({ color: '#b9bcbf', roughness: 0.35, metalness: 0.7 });
const floorMat = new MeshStandardMaterial({ color: '#4a4c4e', roughness: 0.8, metalness: 0.3 });
const lamp = new MeshStandardMaterial({ color: '#fff4d6', emissive: '#fff1c2', emissiveIntensity: 0.7 });
const tail = new MeshStandardMaterial({ color: '#9e1c1c', emissive: '#7a0f0f', emissiveIntensity: 0.5 });

const TUBE = 0.035; // cage tube radius (about 70 mm)
const Y = new Vector3(0, 1, 0);
const v = (p) => new Vector3(p.x, p.y, p.z);

function shadowed(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function tube(group, a, b, radius = TUBE, material = cagePaint) {
  const dir = new Vector3().subVectors(b, a);
  const mesh = shadowed(new Mesh(new CylinderGeometry(radius, radius, dir.length(), 10), material));
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(Y, dir.normalize());
  group.add(mesh);
  return mesh;
}

// A welded joint: a small sphere hides the seam where tubes meet.
function node(group, p, radius = TUBE * 1.15, material = cagePaint) {
  const mesh = shadowed(new Mesh(new SphereGeometry(radius, 10, 8), material));
  mesh.position.copy(p);
  group.add(mesh);
}

function box(group, size, center, material) {
  const mesh = shadowed(new Mesh(new BoxGeometry(size.x, size.y, size.z), material));
  mesh.position.copy(center);
  group.add(mesh);
  return mesh;
}

// Triangular gusset plate in the corner between two tubes meeting at p (toward a and toward b).
function gusset(group, p, a, b, size = 0.14, thickness = 0.012, material = cagePaint) {
  const da = new Vector3().subVectors(a, p).normalize().multiplyScalar(size);
  const db = new Vector3().subVectors(b, p).normalize().multiplyScalar(size);
  const n = new Vector3().crossVectors(da, db).normalize().multiplyScalar(thickness / 2);
  const corners = [p, p.clone().add(da), p.clone().add(db)];
  const verts = [];
  for (const s of [1, -1]) for (const c of corners) verts.push(c.x + n.x * s, c.y + n.y * s, c.z + n.z * s);
  // Two triangles plus three side quads.
  const idx = [0, 1, 2, 3, 5, 4, 0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2, 2, 5, 3, 2, 3, 0];
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3));
  geometry.setIndex(idx);
  geometry.computeVertexNormals();
  const mesh = shadowed(new Mesh(geometry, material));
  group.add(mesh);
  return mesh;
}

// Ladder frame, roll cage with gussets, shock hoops, suspension brackets, floor, seats, and lights.
// Everything is built from frameGeometry/suspensionMounts, so it follows dimension changes. The
// parts are merged into one mesh per material.
export function createFrameMesh(car = CAR) {
  const g = frameGeometry(car);
  const group = new Group();
  group.name = 'frame and cage';
  const L = (x, y, z) => new Vector3(x, y, z);
  const sides = [-1, 1];

  // --- Ladder frame: two box rails and cross members.
  const railLength = g.frontEnd - g.rearEnd;
  for (const s of sides) box(group, L(railLength, g.railHalfHeight * 2, 0.1), L((g.frontEnd + g.rearEnd) / 2, g.railY, s * g.railZ), frameMat);
  for (const x of [g.frontEnd - 0.05, g.frontHoopX, 0, g.mainHoopX, g.rearEnd + 0.05]) {
    box(group, L(0.08, 0.1, g.railZ * 2), L(x, g.railY, 0), frameMat);
  }
  // Outriggers carrying the cage feet outside the rails, with mounting plates.
  for (const x of [g.frontHoopX, g.mainHoopX]) {
    for (const s of sides) {
      const mid = (g.railZ + g.footZ) / 2;
      box(group, L(0.08, 0.08, g.footZ - g.railZ + 0.08), L(x, g.railY + 0.01, s * mid), frameMat);
      box(group, L(0.16, 0.012, 0.16), L(x, g.railTop - 0.004, s * g.footZ), plateMat);
    }
  }
  // Bumpers.
  box(group, L(0.12, 0.12, g.railZ * 2 + 0.5), L(g.frontEnd + 0.04, g.railY + 0.04, 0), frameMat);
  box(group, L(0.12, 0.12, g.railZ * 2 + 0.3), L(g.rearEnd - 0.04, g.railY + 0.04, 0), frameMat);

  // --- Key cage points.
  const foot = (x, s) => L(x, g.railTop, s * g.footZ);
  const mainBend = (s) => L(g.mainHoopX, g.roofY - 0.14, s * (g.footZ - 0.04));
  const mainTop = (s) => L(g.mainHoopX, g.roofY, s * (g.footZ - 0.16));
  const pillarTop = (s) => L(g.pillarTopX, g.roofY - 0.04, s * (g.footZ - 0.14));
  const dash = (s) => L(g.frontHoopX - 0.12, g.dashY, s * (g.footZ - 0.03));
  const frontHorn = (s) => L(g.frontEnd - 0.08, g.railTop + 0.12, s * g.railZ);
  const rearCorner = (s) => L(g.rearEnd + 0.1, g.railTop, s * g.railZ);

  for (const s of sides) {
    // Main hoop behind the seats, with a bent upper corner.
    tube(group, foot(g.mainHoopX, s), mainBend(s));
    tube(group, mainBend(s), mainTop(s));
    node(group, mainBend(s));
    node(group, mainTop(s));
    // A-pillar: from the front foot, through the dash, leaning back to the roof.
    tube(group, foot(g.frontHoopX, s), dash(s));
    tube(group, dash(s), pillarTop(s));
    node(group, dash(s));
    node(group, pillarTop(s));
    // Roof rail and rocker bar.
    tube(group, mainTop(s), pillarTop(s));
    tube(group, foot(g.mainHoopX, s), foot(g.frontHoopX, s));
    // Rear down-tube from the hoop top to the rear of the frame; front clip to the frame horn.
    tube(group, mainTop(s), rearCorner(s));
    tube(group, dash(s), frontHorn(s));
    node(group, rearCorner(s));
    node(group, frontHorn(s));
    // Feet.
    node(group, foot(g.mainHoopX, s));
    node(group, foot(g.frontHoopX, s));

    // Gussets at the weak angles.
    gusset(group, mainBend(s), foot(g.mainHoopX, s), mainTop(s), 0.12);
    gusset(group, mainTop(s), mainBend(s), pillarTop(s), 0.13);
    gusset(group, mainTop(s), mainBend(s), rearCorner(s), 0.12);
    gusset(group, pillarTop(s), dash(s), mainTop(s), 0.13);
    gusset(group, dash(s), foot(g.frontHoopX, s), frontHorn(s), 0.11);
    gusset(group, foot(g.mainHoopX, s), mainBend(s), foot(g.frontHoopX, s), 0.12);
    gusset(group, foot(g.frontHoopX, s), dash(s), foot(g.mainHoopX, s), 0.1);
  }
  // Cross tubes: main hoop top, windscreen header, dash bar, and a diagonal in the main hoop.
  tube(group, mainTop(-1), mainTop(1));
  tube(group, pillarTop(-1), pillarTop(1));
  tube(group, dash(-1), dash(1), TUBE * 0.9);
  tube(group, foot(g.mainHoopX, -1), mainBend(1), TUBE * 0.9);
  // Harness bar across the main hoop at shoulder height.
  const shoulder = (s) => L(g.mainHoopX, g.railTop + 0.72, s * (g.footZ - 0.02));
  tube(group, shoulder(-1), shoulder(1), TUBE * 0.85);

  // --- Shock hoops: coil-over tops carried by hoops built into the cage, triangulated back to it.
  for (const [a, b] of [
    [0, 1],
    [2, 3],
  ]) {
    const left = suspensionMounts(a, car);
    const right = suspensionMounts(b, car);
    const tops = [v(left.shockTop), v(right.shockTop)];
    const hoopY = Math.max(tops[0].y, tops[1].y) + 0.1;
    const x = tops[0].x;
    const upper = sides.map((s) => L(x, hoopY, s * (g.shockZ - 0.06)));
    for (const [k, s] of sides.entries()) {
      const legFoot = L(x, g.railTop, s * g.railZ);
      tube(group, legFoot, upper[k]);
      node(group, upper[k]);
      node(group, legFoot);
      // Brace from the hoop top back to the cage (down-tube side at the rear, dash at the front).
      const brace = left.toward > 0 ? dash(s) : mainTop(s).clone().lerp(rearCorner(s), 0.35);
      tube(group, upper[k], brace, TUBE * 0.85);
      gusset(group, upper[k], legFoot, brace, 0.1);
      gusset(group, legFoot, upper[k], L(x + left.toward * 0.3, g.railTop, s * g.railZ), 0.1, 0.012, frameMat);
      // Shock-top bracket: a pair of tabs with the pin between them.
      const top = tops[k];
      for (const dx of [-0.035, 0.035]) box(group, L(0.01, 0.09, 0.07), L(top.x + dx, top.y + 0.02, top.z), bracketMat);
      box(group, L(0.1, 0.02, 0.02), L(top.x, top.y, top.z), bracketMat);
    }
    tube(group, upper[0], upper[1]);
    // Diagonal inside the shock hoop.
    tube(group, L(x, g.railTop, -g.railZ), upper[1], TUBE * 0.8);
    // Headlights on the front shock hoop.
    if (left.toward < 0) for (const s of sides) box(group, L(0.05, 0.12, 0.16), L(x + 0.06, hoopY - 0.02, s * 0.32), lamp);
    else for (const s of sides) box(group, L(0.04, 0.08, 0.12), L(g.rearEnd - 0.11, g.railY + 0.06, s * (g.railZ + 0.1)), tail);
  }

  // --- Suspension link brackets on the frame rails (4-link and A-arm pivots).
  for (let i = 0; i < 4; i++) {
    const m = suspensionMounts(i, car);
    for (const p of car.solidAxles ? [m.lowerLinkFrame, m.upperLinkFrame] : [m.upperArmFrame, m.lowerArmFrame]) {
      box(group, L(0.1, 0.12, 0.012), L(p.x, p.y, p.z + m.side * 0.03), bracketMat);
      box(group, L(0.1, 0.12, 0.012), L(p.x, p.y, p.z - m.side * 0.03), bracketMat);
    }
  }

  // --- Floor pan between the hoops, seats on it, and a steering column from the dash.
  const floorLength = g.frontHoopX - g.mainHoopX;
  box(group, L(floorLength, 0.01, g.footZ * 2), L((g.frontHoopX + g.mainHoopX) / 2, g.railTop + 0.005, 0), floorMat);
  // Nothing here moves relative to the chassis: one draw call per material.
  return mergeByMaterial(group);
}
