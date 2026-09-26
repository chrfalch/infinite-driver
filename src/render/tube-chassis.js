// Procedural tube chassis: the whole car structure is one welded tube frame (floor rails, cage,
// bumpers, shock towers, and link brackets), no separate ladder frame. Each design is written as
// tubes through chassis-local points (x forward, y up, z right; metres), mirrored left/right.
// Bends are rounded like mandrel-bent tube; joints get a weld bead; corners get gussets.
import {
  BoxGeometry,
  BufferAttribute,
  CylinderGeometry,
  BufferGeometry,
  CurvePath,
  Group,
  LineCurve3,
  Mesh,
  MeshStandardMaterial,
  QuadraticBezierCurve3,
  SphereGeometry,
  TubeGeometry,
  Vector3,
} from 'three/webgpu';
import { PICKUPS as SAND_BUGGY_PICKUPS } from '../vehicle/frame-geometry.js';

const MAIN = 0.024; // 48 mm OD main hoops and rails
const SEC = 0.019; // 38 mm OD bracing
const SMALL = 0.014; // 28 mm OD door bars, light bracing

const bracket = new MeshStandardMaterial({ color: '#b9bcbf', roughness: 0.35, metalness: 0.7 });
const skid = new MeshStandardMaterial({ color: '#43474a', roughness: 0.55, metalness: 0.6 });

const V = (p) => new Vector3(p[0], p[1], p[2]);
const mirror = (p) => [p[0], p[1], -p[2]];

// A tube through points with rounded (mandrel) bends of the given radius at each corner.
function tubePath(points, bend) {
  const pts = points.map(V);
  const path = new CurvePath();
  let from = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const toPrev = new Vector3().subVectors(pts[i - 1], p);
    const toNext = new Vector3().subVectors(pts[i + 1], p);
    const d = Math.min(bend, toPrev.length() * 0.45, toNext.length() * 0.45);
    const a = p.clone().addScaledVector(toPrev.normalize(), d);
    const b = p.clone().addScaledVector(toNext.normalize(), d);
    if (from.distanceTo(a) > 1e-4) path.add(new LineCurve3(from.clone(), a));
    path.add(new QuadraticBezierCurve3(a, p.clone(), b));
    from = b;
  }
  path.add(new LineCurve3(from.clone(), pts[pts.length - 1]));
  return path;
}

class Builder {
  constructor(paint) {
    this.group = new Group();
    this.paint = paint;
    this.joints = new Map();
  }

  mesh(geometry, material) {
    const m = new Mesh(geometry, material);
    m.castShadow = true;
    m.receiveShadow = true;
    this.group.add(m);
    return m;
  }

  // Weld bead where tubes meet (one per point, sized for the thickest tube).
  joint(p, r) {
    const key = p.map((c) => c.toFixed(3)).join(',');
    const prev = this.joints.get(key);
    if (!prev || prev.r < r) this.joints.set(key, { p, r });
  }

  tube(points, r = MAIN, bend = 0.1) {
    const path = tubePath(points, bend);
    const length = path.getLength();
    this.mesh(new TubeGeometry(path, Math.max(2, Math.ceil(length / 0.05)), r, 12, false), this.paint);
    this.joint(points[0], r);
    this.joint(points[points.length - 1], r);
  }

  // The same tube on both sides (points given for the right side, z > 0).
  sym(points, r = MAIN, bend = 0.1) {
    this.tube(points, r, bend);
    this.tube(points.map(mirror), r, bend);
  }

  // A straight tube across the car between a point and its mirror image.
  cross(p, r = SEC) {
    this.tube([mirror(p), p], r);
  }

  // Triangular gusset in the corner at p between tubes toward a and b (both sides with sym).
  gusset(p, a, b, size = 0.1, both = true) {
    const make = (p, a, b) => {
      const P = V(p);
      const da = V(a).sub(P).normalize().multiplyScalar(size);
      const db = V(b).sub(P).normalize().multiplyScalar(size);
      const n = new Vector3().crossVectors(da, db).normalize().multiplyScalar(0.004);
      const c = [P, P.clone().add(da), P.clone().add(db)];
      const verts = [];
      for (const s of [1, -1]) for (const q of c) verts.push(q.x + n.x * s, q.y + n.y * s, q.z + n.z * s);
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3));
      g.setIndex([0, 1, 2, 3, 5, 4, 0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2, 2, 5, 3, 2, 3, 0]);
      g.computeVertexNormals();
      this.mesh(g, this.paint);
    };
    make(p, a, b);
    if (both) make(mirror(p), mirror(a), mirror(b));
  }

  // Double-shear link or shock tab: two plates either side of the mount point.
  tab(p, along = 'x', both = true) {
    const make = (q) => {
      for (const s of [-1, 1]) {
        const size = along === 'x' ? [0.09, 0.07, 0.006] : [0.006, 0.07, 0.09];
        const m = this.mesh(new BoxGeometry(...size), bracket);
        m.position.set(q[0], q[1] - 0.02, q[2] + (along === 'x' ? s * 0.03 : 0));
        if (along !== 'x') m.position.x += s * 0.03;
      }
    };
    make(p);
    if (both) make(mirror(p));
  }

  // Flat sheet (skid plate, floor) through four corners.
  plate(corners, material = skid, thickness = 0.006) {
    const [a, b, c, d] = corners.map(V);
    const n = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(d, a)).normalize().multiplyScalar(thickness / 2);
    const verts = [];
    for (const s of [1, -1]) for (const q of [a, b, c, d]) verts.push(q.x + n.x * s, q.y + n.y * s, q.z + n.z * s);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3));
    g.setIndex([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]);
    g.computeVertexNormals();
    this.mesh(g, material);
  }

  finish() {
    for (const { p, r } of this.joints.values()) {
      const m = this.mesh(new SphereGeometry(r * 1.18, 12, 8), this.paint);
      m.position.set(p[0], p[1], p[2]);
    }
    return this.group;
  }
}

// Suspension pick-ups every design must reach (solid axles, 4-link), per side (right, z > 0).
// Front axle at x = +1.35, rear at -1.35; hubs at about y = -0.45 at ride height.
export const PICKUPS = {
  shockTop: (front) => [front ? 1.23 : -1.23, 0.38, 0.72],
  lowerLink: (front) => [front ? 0.4 : -0.4, -0.41, 0.45],
  upperLink: (front) => [front ? 0.7 : -0.7, -0.22, 0.25],
};

// Shared belly: two inner rails and two outer rockers joined by cross tubes, a skid plate under it,
// link tabs, and the kick-ups over each axle to the bumpers.
function belly(b, { rocker = 0.62, railZ = 0.45, y = -0.41, length = 0.95, kickY = -0.08, endX = 1.95, endY = -0.02, endZ = 0.4 } = {}) {
  b.sym([[length, y, railZ], [-length, y, railZ]], MAIN);
  b.sym([[0.75, y + 0.04, rocker], [-0.75, y + 0.04, rocker]], MAIN);
  for (const x of [0.75, 0.2, -0.3, -0.75]) b.sym([[x, y + 0.04, rocker], [x, y, railZ]], SEC);
  for (const x of [0.95, 0.2, -0.3, -0.95]) b.cross([x, y, railZ], SEC);
  for (const f of [1, -1]) {
    // Kick-up over the axle, then forward/back to the bumper.
    b.sym([[f * length, y, railZ], [f * 1.3, kickY, railZ - 0.02], [f * endX, endY, endZ]], MAIN, 0.14);
    b.cross([f * 1.3, kickY, railZ - 0.02], SEC);
    // Upper link cross member with its tabs.
    const u = PICKUPS.upperLink(f > 0);
    b.sym([[u[0], y, railZ], u], SEC);
    b.cross(u, SEC);
    b.tab(u);
    b.tab(PICKUPS.lowerLink(f > 0));
  }
  b.plate([[0.95, y - 0.03, railZ], [0.95, y - 0.03, -railZ], [-0.95, y - 0.03, -railZ], [-0.95, y - 0.03, railZ]]);
}

// Tubular bumper with a hoop and a stinger/diagonals.
function bumper(b, f, { x = 1.95, y = -0.02, z = 0.4, hoopY = 0.28 } = {}) {
  const X = f * x;
  b.cross([X, y, z], MAIN);
  b.sym([[X, y, z], [X - f * 0.05, hoopY, z - 0.08], [X - f * 0.05, hoopY, 0]], SEC, 0.08);
  b.sym([[X - f * 0.05, hoopY, z - 0.08], [X - f * 0.45, 0.08, 0.5]], SMALL);
}

// Shock tower: tubes from the cage down to the shock top and on to the kick-up rail, triangulated.
function shockTower(b, f, from, { railZ = 0.43, kickY = -0.08 } = {}) {
  const top = PICKUPS.shockTop(f > 0);
  b.sym([from, top, [f * 1.36, kickY, railZ]], MAIN, 0.08);
  b.sym([top, [f * 0.95, -0.37, 0.6]], SEC);
  b.cross([top[0], top[1], top[2]], SEC);
  b.tab(top, 'z');
}

const T = 0.031; // 62 mm OD: the chunky tube of the sand buggy
const T2 = 0.025;
const plateMat = new MeshStandardMaterial({ color: '#8f9498', roughness: 0.5, metalness: 0.55 });
const lampMat = new MeshStandardMaterial({ color: '#fff4d6', emissive: '#fff1c2', emissiveIntensity: 0.6, roughness: 0.2 });
const lampBody = new MeshStandardMaterial({ color: '#1d1e20', roughness: 0.4, metalness: 0.6 });

// Sand buggy after the user's reference: few, thick tubes in long flowing bends; low wide rockers
// that sweep up into a compact nose box; A-pillars that run in one line into the roof and down
// into the rear frame; a shoulder bar; diamond-plate floor; round lamps.
const sandBuggy = {
  name: 'Sand buggy',
  note: 'After your reference: chunky tube in long bends, a low nose box with a hoop bumper, A-pillars that run into a long roof and down to the rear hoop.',
  paint: '#f0643c',
  pickups: SAND_BUGGY_PICKUPS,
  build(b) {
    const F = -0.4; // floor tube centre
    // Nose box corners (right side): rear-bottom, rear-top, front-bottom, front-top.
    const NRB = [1.05, -0.3, 0.52];
    const NRT = [1.05, 0.12, 0.54];
    const NFB = [1.8, -0.3, 0.42];
    const NFT = [1.8, 0.12, 0.42];
    // Main hoop feet and top, windshield header, rear hoop.
    const MHF = [-0.6, F, 0.66];
    const MHT = [-0.6, 0.9, 0.5];
    const HDR = [0.25, 0.88, 0.52];
    const RHT = [-1.75, 0.12, 0.45];
    const RHB = [-1.75, -0.25, 0.45];

    // Rockers: along the floor edge, then a gentle rise into the bottom of the nose box.
    b.sym([MHF, [0.72, F, 0.66], NRB, NFB], T, 0.3);
    // Rear lower rails: from the main hoop feet up to the bottom of the rear hoop.
    b.sym([MHF, [-1.2, -0.33, 0.58], RHB], T, 0.2);
    // Nose box: uprights, top rails, crosses, and one side diagonal.
    b.sym([NRB, NRT], T2);
    b.sym([NFB, NFT], T2);
    b.sym([NRT, NFT], T);
    b.sym([NFT, NRB], T2 * 0.8);
    b.cross(NFT, T2);
    b.cross(NFB, T2);
    b.cross([1.22, 0.12, 0.51], T2); // front shock cross member
    // Hoop bumper wrapped round the front of the nose box.
    b.tube([[1.8, -0.12, 0.42], [2.0, -0.12, 0.34], [2.0, -0.12, -0.34], [1.8, -0.12, -0.42]], T2, 0.14);
    // A-pillars: from the top of the nose box up to the header, back along the roof, over the
    // main hoop, and down in one long bend to the rear hoop.
    const RRF = [-1.15, 0.86, 0.48]; // rear end of the roof
    b.sym([NRT, HDR, MHT, RRF, RHT, RHB], T, 0.2);
    b.cross(HDR, T2);
    b.cross(RRF, T2);
    // Main hoop and harness bar.
    b.tube([MHF, MHT, [MHT[0], MHT[1], -MHT[2]], [MHF[0], MHF[1], -MHF[2]]], T, 0.18);
    b.cross([-0.6, 0.38, 0.6], T2);
    // Side bars: nose box to main hoop, slightly bowed out, then on to the rear hoop.
    b.sym([NRT, [0.25, 0.17, 0.69], [-0.6, 0.2, 0.655]], T, 0.4);
    b.sym([[-0.6, 0.2, 0.655], [-1.2, 0.2, 0.6], RHT], T2, 0.2);
    // Rear posts from the lower rail up through the shock mount to the rear of the roof.
    b.sym([[-1.2, -0.33, 0.58], [-1.2, 0.2, 0.6], RRF], T2, 0.08);
    b.cross([-1.2, 0.2, 0.6], T2);
    b.cross(RHT, T2);
    b.cross(RHB, T);
    b.tube([RHB, [RHT[0], RHT[1], -RHT[2]]], T2 * 0.8); // rear diagonal
    // Dash bar between the A-pillars.
    b.cross([0.69, 0.46, 0.53], T2);
    // Floor cross members and link mounts.
    for (const x of [0.72, 0.1, -0.6]) b.cross([x, F, 0.66], T2);
    for (const f of [1, -1]) {
      const u = sandBuggy.pickups.upperLink(f > 0);
      b.sym([[u[0], F, 0.66], u], T2 * 0.8);
      b.cross(u, T2 * 0.8);
      b.tab(u);
      b.tab(sandBuggy.pickups.lowerLink(f > 0));
      b.tab(sandBuggy.pickups.shockTop(f > 0), 'z');
    }
    // Diamond-plate floor between the rockers.
    b.plate([[0.72, F + 0.02, 0.64], [0.72, F + 0.02, -0.64], [-0.6, F + 0.02, -0.64], [-0.6, F + 0.02, 0.64]], plateMat);
    // Round lamps on top of the nose box, facing forward.
    for (const s of [1, -1]) {
      const body = b.mesh(new CylinderGeometry(0.075, 0.06, 0.08, 20), lampBody);
      body.rotation.z = Math.PI / 2;
      body.position.set(1.86, 0.22, s * 0.34);
      const lens = b.mesh(new CylinderGeometry(0.066, 0.066, 0.01, 20), lampMat);
      lens.rotation.z = Math.PI / 2;
      lens.position.set(1.905, 0.22, s * 0.34);
      const stem = b.mesh(new CylinderGeometry(0.012, 0.012, 0.08, 8), lampBody);
      stem.position.set(1.82, 0.16, s * 0.36);
    }
  },
};

export const DESIGNS = [
  sandBuggy,
  {
    name: 'Ultra4 rock bouncer',
    note: 'Short, tall and fully triangulated. Exo cage with the shock towers built into the cage.',
    paint: '#d9683f',
    build(b) {
      belly(b);
      // Main hoop behind the seats: one bent tube.
      b.tube([[-0.65, -0.37, 0.62], [-0.65, 0.74, 0.58], [-0.65, 0.74, -0.58], [-0.65, -0.37, -0.62]], MAIN, 0.14);
      // A-pillars bend at the dash and run back as roof rails.
      b.sym([[0.75, -0.37, 0.62], [0.62, 0.12, 0.64], [0.02, 0.76, 0.56], [-0.65, 0.74, 0.58]], MAIN, 0.14);
      b.cross([0.62, 0.12, 0.64], SEC);
      b.cross([0.02, 0.76, 0.56], SEC);
      // Roof X and main-hoop diagonal.
      b.tube([[0.02, 0.76, 0.56], [-0.65, 0.74, -0.58]], SEC);
      b.tube([[0.02, 0.76, -0.56], [-0.65, 0.74, 0.58]], SEC);
      b.tube([[-0.65, -0.37, 0.62], [-0.65, 0.74, -0.58]], SEC);
      b.cross([-0.65, 0.3, 0.6], SEC); // harness bar
      // Door bars.
      b.sym([[0.62, 0.12, 0.64], [-0.65, 0.18, 0.61]], SMALL);
      b.sym([[0.2, -0.33, 0.62], [-0.2, 0.17, 0.62]], SMALL);
      // Front: shock towers from the A-pillars, bumper.
      shockTower(b, 1, [0.3, 0.45, 0.6]);
      b.sym([[0.62, 0.12, 0.64], [1.23, 0.38, 0.72]], SEC);
      bumper(b, 1);
      // Rear: towers from the main hoop top, engine bay box, bumper.
      shockTower(b, -1, [-0.65, 0.74, 0.58]);
      b.sym([[-0.65, 0.1, 0.62], [-1.23, 0.38, 0.72]], SEC);
      b.cross([-1.0, 0.54, 0.66], SEC);
      bumper(b, -1);
      b.gusset([-0.65, 0.74, 0.58], [-0.65, 0.3, 0.6], [0.02, 0.76, 0.56]);
      b.gusset([0.62, 0.12, 0.64], [0.75, -0.37, 0.62], [0.02, 0.76, 0.56]);
    },
  },
  {
    name: 'Sand rail',
    note: 'Long and low. A laid-back cage flows into a pointed nose; the engine cage sits behind the seats.',
    paint: '#e8b53a',
    build(b) {
      belly(b, { endX: 1.9, endZ: 0.26, endY: 0.0 });
      // Main hoop, leaning back a little.
      b.tube([[-0.6, -0.37, 0.62], [-0.72, 0.7, 0.54], [-0.72, 0.7, -0.54], [-0.6, -0.37, -0.62]], MAIN, 0.2);
      // One long bent roof rail per side: from the main hoop over the cockpit and down to the nose.
      b.sym([[-0.72, 0.7, 0.54], [-0.05, 0.74, 0.5], [0.75, 0.3, 0.5], [1.35, 0.12, 0.36], [1.9, 0.0, 0.26]], MAIN, 0.25);
      b.sym([[0.75, -0.37, 0.62], [0.75, 0.3, 0.5]], MAIN);
      b.cross([0.75, 0.3, 0.5], SEC);
      b.cross([-0.05, 0.74, 0.5], SEC);
      b.cross([1.35, 0.12, 0.36], SEC);
      b.cross([1.9, 0.0, 0.26], MAIN);
      b.tube([[-0.05, 0.74, 0.5], [-0.72, 0.7, -0.54]], SEC);
      b.tube([[-0.6, -0.37, -0.62], [-0.72, 0.7, 0.54]], SEC);
      b.cross([-0.66, 0.25, 0.58], SEC);
      b.sym([[0.75, 0.3, 0.5], [-0.62, 0.05, 0.62]], SMALL);
      // Front towers from the nose rails.
      shockTower(b, 1, [0.75, 0.3, 0.5]);
      // Engine cage: roof extends back and down to the rear towers and a low rear bumper.
      b.sym([[-0.72, 0.7, 0.54], [-1.23, 0.38, 0.72]], MAIN);
      shockTower(b, -1, [-0.72, 0.7, 0.54]);
      b.sym([[-1.23, 0.38, 0.72], [-1.85, 0.1, 0.42], [-1.95, -0.02, 0.4]], SEC, 0.1);
      b.cross([-1.85, 0.1, 0.42], SEC);
      bumper(b, -1, { hoopY: 0.12 });
      b.gusset([-0.72, 0.7, 0.54], [-0.66, 0.25, 0.58], [-0.05, 0.74, 0.5]);
    },
  },
  {
    name: 'Trophy truck',
    note: 'Wide front clip with tall shock hoops, a long cab, and a rear cage over the axle.',
    paint: '#f2efe6',
    build(b) {
      belly(b, { length: 1.0 });
      b.tube([[-0.62, -0.37, 0.62], [-0.62, 0.8, 0.6], [-0.62, 0.8, -0.6], [-0.62, -0.37, -0.62]], MAIN, 0.12);
      b.sym([[0.8, -0.37, 0.62], [0.68, 0.18, 0.66], [0.18, 0.82, 0.6], [-0.62, 0.8, 0.6]], MAIN, 0.12);
      b.cross([0.68, 0.18, 0.66], SEC);
      b.cross([0.18, 0.82, 0.6], SEC);
      b.tube([[0.18, 0.82, 0.6], [-0.62, 0.8, -0.6]], SEC);
      b.tube([[-0.62, -0.37, 0.62], [-0.62, 0.8, -0.6]], SEC);
      b.cross([-0.62, 0.32, 0.6], SEC);
      b.sym([[0.68, 0.18, 0.66], [-0.62, 0.2, 0.62]], SMALL);
      // Front clip: a wide hoop over the shock tops, braced to the dash and the bumper.
      const top = PICKUPS.shockTop(true);
      b.tube([[1.23, -0.08, 0.43], [top[0], 0.52, 0.72], [top[0], 0.52, -0.72], [1.23, -0.08, -0.43]], MAIN, 0.12);
      b.sym([[0.68, 0.18, 0.66], [top[0], 0.52, 0.72]], SEC);
      b.sym([[0.18, 0.82, 0.6], [top[0], 0.52, 0.6]], SEC);
      b.sym([[top[0], 0.52, 0.6], [1.95, 0.15, 0.36]], SEC);
      b.tab(top, 'z');
      bumper(b, 1, { hoopY: 0.15 });
      b.cross([1.72, 0.3, 0.3], SMALL); // light bar
      // Rear: tall shock hoop and a cage box over the axle.
      const rt = PICKUPS.shockTop(false);
      b.tube([[-1.3, -0.08, 0.43], [rt[0], 0.62, 0.72], [rt[0], 0.62, -0.72], [-1.3, -0.08, -0.43]], MAIN, 0.12);
      b.sym([[-0.62, 0.8, 0.6], [rt[0], 0.62, 0.66]], SEC);
      b.sym([[-0.62, 0.1, 0.62], [rt[0], 0.62, 0.72], [-1.9, 0.3, 0.45]], SEC, 0.06);
      b.sym([[rt[0], -0.02, 0.6], [-1.9, 0.3, 0.45], [-1.95, -0.02, 0.4]], SEC, 0.06);
      b.cross([-1.9, 0.3, 0.45], SEC);
      b.tab(rt, 'z');
      bumper(b, -1, { hoopY: 0.1 });
      b.gusset([-0.62, 0.8, 0.6], [-0.62, 0.32, 0.6], [0.18, 0.82, 0.6]);
    },
  },
  {
    name: 'Baja cage',
    note: 'Classic look: big smooth bends, fewer tubes, a rounded roof and a hoop bumper.',
    paint: '#5f7f55',
    build(b) {
      belly(b);
      // Hoops with large bend radii.
      b.tube([[-0.62, -0.37, 0.62], [-0.62, 0.72, 0.56], [-0.62, 0.72, -0.56], [-0.62, -0.37, -0.62]], MAIN, 0.3);
      b.sym([[0.78, -0.37, 0.62], [0.55, 0.3, 0.62], [-0.05, 0.74, 0.54], [-0.62, 0.72, 0.56]], MAIN, 0.32);
      b.cross([0.55, 0.3, 0.62], SEC);
      b.cross([-0.05, 0.74, 0.54], SEC);
      b.cross([-0.62, 0.28, 0.6], SEC);
      b.tube([[-0.62, -0.37, 0.62], [-0.62, 0.72, -0.56]], SEC);
      b.sym([[0.55, 0.3, 0.62], [-0.62, 0.1, 0.62]], SMALL, 0.2);
      // Front: rounded hoop over the nose meets the shock towers.
      shockTower(b, 1, [0.55, 0.3, 0.62]);
      b.tube([[1.95, -0.02, 0.4], [1.9, 0.3, 0.3], [1.9, 0.3, -0.3], [1.95, -0.02, -0.4]], SEC, 0.2);
      b.cross([1.95, -0.02, 0.4], MAIN);
      // Rear.
      shockTower(b, -1, [-0.62, 0.72, 0.56]);
      b.tube([[-1.95, -0.02, 0.4], [-1.9, 0.25, 0.32], [-1.9, 0.25, -0.32], [-1.95, -0.02, -0.4]], SEC, 0.2);
      b.cross([-1.95, -0.02, 0.4], MAIN);
    },
  },
];

export function createTubeChassis(index = 0) {
  const design = DESIGNS[index % DESIGNS.length];
  const b = new Builder(new MeshStandardMaterial({ color: design.paint, roughness: 0.4, metalness: 0.3 }));
  design.build(b);
  return { group: b.finish(), design };
}
