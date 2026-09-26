// Bronze 8-hole beadlock wheel: barrel, a dished face with eight round cut-outs, a dark centre hub
// with lug nuts and a cap, and the outer beadlock ring clamped by a circle of bolts. Wheel-local
// space with the axle along z; `side` (+1 or -1) is the outboard direction.
import {
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Path,
  Shape,
} from 'three/webgpu';

const bronze = new MeshStandardMaterial({ color: '#a8742c', roughness: 0.32, metalness: 0.85 });
const bronzeDark = new MeshStandardMaterial({ color: '#7a531f', roughness: 0.4, metalness: 0.8 });
const hubMat = new MeshStandardMaterial({ color: '#1c1d1f', roughness: 0.35, metalness: 0.7 });
const boltMat = new MeshStandardMaterial({ color: '#c9c7c2', roughness: 0.25, metalness: 0.9 });

function shaded(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// A flat part in the wheel plane (xy), extruded along z by `depth`, centred on z = 0.
function plate(shape, depth, material) {
  const g = new ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: depth * 0.25, bevelSize: depth * 0.25, bevelSegments: 1, curveSegments: 40 });
  g.translate(0, 0, -depth / 2);
  return shaded(new Mesh(g, material));
}

const circle = (r, holes = []) => {
  const s = new Shape();
  s.absarc(0, 0, r, 0, Math.PI * 2, false);
  for (const h of holes) s.holes.push(h);
  return s;
};
const hole = (x, y, r) => {
  const p = new Path();
  p.absarc(x, y, r, 0, Math.PI * 2, true);
  return p;
};

export function createBeadlockWheel(rimRadius, width, side = 1) {
  const group = new Group();
  const out = side * (width / 2); // outboard edge of the barrel
  // Barrel (open cylinder), darker inside.
  const barrel = shaded(new Mesh(new CylinderGeometry(rimRadius, rimRadius, width, 40, 1, true), bronzeDark));
  barrel.rotation.x = Math.PI / 2;
  barrel.material.side = 2; // double sided
  group.add(barrel);
  // Inner (inboard) lip.
  const lip = plate(circle(rimRadius + 0.018, [hole(0, 0, rimRadius - 0.004)]), 0.01, bronzeDark);
  lip.position.z = -out;
  group.add(lip);

  // Dished face, set back from the outboard edge, with eight round cut-outs.
  const faceR = rimRadius - 0.01;
  const holes = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    holes.push(hole(Math.cos(a) * faceR * 0.6, Math.sin(a) * faceR * 0.6, faceR * 0.2));
  }
  holes.push(hole(0, 0, 0.055)); // centre bore
  const face = plate(circle(faceR, holes), 0.014, bronze);
  face.position.z = out - side * 0.045;
  group.add(face);
  // A raised ring around the cut-outs gives the dish some depth.
  const rib = plate(circle(faceR * 0.36, [hole(0, 0, faceR * 0.3)]), 0.012, bronze);
  rib.position.z = out - side * 0.036;
  group.add(rib);

  // Centre hub, lug nuts and cap.
  const hub = shaded(new Mesh(new CylinderGeometry(0.068, 0.072, 0.05, 28), hubMat));
  hub.rotation.x = Math.PI / 2;
  hub.position.z = out - side * 0.03;
  group.add(hub);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const nut = shaded(new Mesh(new CylinderGeometry(0.011, 0.011, 0.022, 6), boltMat));
    nut.rotation.x = Math.PI / 2;
    nut.position.set(Math.cos(a) * 0.046, Math.sin(a) * 0.046, out - side * 0.005);
    group.add(nut);
  }
  const cap = shaded(new Mesh(new CylinderGeometry(0.026, 0.03, 0.02, 20), hubMat));
  cap.rotation.x = Math.PI / 2;
  cap.position.z = out + side * 0.002;
  group.add(cap);

  // Beadlock ring on the outboard lip, overlapping the tyre bead, with 24 bolts.
  const ringIn = rimRadius - 0.012;
  const ringOut = rimRadius + 0.04;
  const ring = plate(circle(ringOut, [hole(0, 0, ringIn)]), 0.014, bronze);
  ring.position.z = out;
  group.add(ring);
  const boltR = (ringIn + ringOut) / 2;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const bolt = shaded(new Mesh(new CylinderGeometry(0.0075, 0.0075, 0.012, 6), boltMat));
    bolt.rotation.x = Math.PI / 2;
    bolt.position.set(Math.cos(a) * boltR, Math.sin(a) * boltR, out + side * 0.012);
    group.add(bolt);
  }
  return group;
}
