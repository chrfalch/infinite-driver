import {
  BoxGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from 'three/webgpu';
import { CAR } from '../vehicle/config.js';
import { wheelMount } from '../vehicle/physics.js';
import { createAxleRig } from './axles.js';
import { createFrameMesh } from './frame-mesh.js';
import { mergeByMaterial } from './merge-geometry.js';
import { frameGeometry, suspensionMounts } from '../vehicle/frame-geometry.js';

const frame = new MeshStandardMaterial({ color: '#2d2f31', roughness: 0.7, metalness: 0.3 });
const seat = new MeshStandardMaterial({ color: '#4a4136', roughness: 0.9 });
const tyre = new MeshStandardMaterial({ color: '#232221', roughness: 0.95 });
const rim = new MeshStandardMaterial({ color: '#c9c6bd', roughness: 0.4, metalness: 0.6 });
const springMat = new MeshStandardMaterial({ color: '#e8c547', roughness: 0.4, metalness: 0.4 });
const damperMat = new MeshStandardMaterial({ color: '#1d1d1d', roughness: 0.4, metalness: 0.6 });
const chrome = new MeshStandardMaterial({ color: '#d7d7d7', roughness: 0.2, metalness: 0.9 });

function shadowed(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function box(w, h, d, material, x, y, z) {
  const m = shadowed(new Mesh(new BoxGeometry(w, h, d), material));
  m.position.set(x, y, z);
  return m;
}

// A tube between two points in the car's local frame.
function bar(a, b, radius, material) {
  const dir = new Vector3().subVectors(b, a);
  const m = shadowed(new Mesh(new CylinderGeometry(radius, radius, dir.length(), 8), material));
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
  return m;
}

// Where the steering parts sit (chassis-local), shared with the axle rig and the tests.
// Wheel → short column stub → universal joint → intermediate shaft → universal joint → short
// input shaft → steering box on the frame rail. Each joint only takes a moderate angle.
export function steeringGeometry(g = frameGeometry()) {
  const dashX = g.frontHoopX - 0.12;
  const faceNormal = new Vector3(-0.72, 0.69, 0).normalize();
  const wheelCenter = new Vector3(dashX - 0.34, g.dashY + 0.08, -0.3);
  const columnAxis = faceNormal.clone().negate(); // from the wheel toward the dash
  const joint1 = wheelCenter.clone().addScaledVector(columnAxis, 0.16);
  const front = suspensionMounts(0);
  // Steering box on the outside of the left frame rail, just behind the front axle.
  const box = new Vector3(front.mount.x - 0.32, g.railY + 0.02, -(g.railZ + 0.1));
  // The box's input shaft points up and back toward the driver, a little steeper than the
  // intermediate shaft, so both joints share the bend.
  const toJoint1 = joint1.clone().sub(box).normalize();
  const boxInput = toJoint1.clone().lerp(new Vector3(-0.2, 1, 0).normalize(), 0.3).normalize();
  const joint2 = box.clone().addScaledVector(boxInput, 0.14);
  return { wheelCenter, faceNormal, columnAxis, joint1, joint2, box, boxInput };
}

// Bend (degrees) at each steering universal joint.
export function steeringJointAngles(geo = steeringGeometry()) {
  const shaft = geo.joint2.clone().sub(geo.joint1).normalize();
  const input = geo.boxInput.clone().negate(); // from joint 2 into the box
  const deg = (a, b) => (Math.acos(Math.min(1, Math.max(-1, a.dot(b)))) * 180) / Math.PI;
  return { upper: deg(geo.columnAxis, shaft), lower: deg(shaft, input) };
}

// Chassis-local: +x forward, +y up, +z right. Origin is the physics body origin.
// A buggy with no body panels: ladder frame, roll cage, seats, steering, and running gear.
export function createCarMesh() {
  const g = frameGeometry();
  const car = new Group();
  // Parts fixed to the chassis go into `body`, merged into one mesh per material at the end.
  const body = new Group();
  body.name = 'frame and cage';
  body.add(createFrameMesh());

  // Seats on the floor pan between the hoops, driver on the left (-z).
  const seatX = (g.frontHoopX + g.mainHoopX) / 2 - 0.12;
  for (const z of [-0.3, 0.3]) {
    body.add(box(0.46, 0.1, 0.44, seat, seatX, g.railTop + 0.13, z));
    body.add(box(0.1, 0.55, 0.44, seat, seatX - 0.25, g.railTop + 0.42, z));
    // Seat mounts to the floor.
    body.add(box(0.36, 0.08, 0.05, frame, seatX, g.railTop + 0.05, z - 0.17));
    body.add(box(0.36, 0.08, 0.05, frame, seatX, g.railTop + 0.05, z + 0.17));
  }

  // Steering: the wheel faces the driver, tilted up and back; its column runs forward and down
  // through a bracket on the dash bar. The shaft to the steering box and the linkage to the front
  // axle are in the axle rig, which moves them with the steering.
  const steeringWheel = new Group();
  const ring = shadowed(new Mesh(new TorusGeometry(0.17, 0.022, 8, 24), frame));
  const spoke = box(0.3, 0.03, 0.03, frame, 0, 0, 0);
  const spoke2 = box(0.03, 0.3, 0.03, frame, 0, 0, 0);
  steeringWheel.add(ring, spoke, spoke2);
  mergeByMaterial(steeringWheel);
  const steer = steeringGeometry(g);
  const column = new Group();
  column.position.copy(steer.wheelCenter);
  // Face normal points up and back at the driver.
  column.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), steer.faceNormal);
  column.add(steeringWheel);
  car.add(column);
  // Column stub from the wheel to the first universal joint, held by a bracket on the dash bar.
  body.add(bar(steer.wheelCenter, steer.joint1, 0.022, frame));
  const clamp = steer.wheelCenter.clone().lerp(steer.joint1, 0.6);
  body.add(bar(clamp, new Vector3(clamp.x + 0.08, g.dashY, clamp.z), 0.016, frame));
  body.add(box(0.05, 0.05, 0.07, frame, clamp.x + 0.08, g.dashY, clamp.z));
  car.add(mergeByMaterial(body));

  const axles = createAxleRig();
  car.add(axles.group);

  return { object: car, steeringWheel, axles };
}

// The wheel rim with lug nuts; a spoke pair makes the spin visible when the tyre is soft.
function createRim(rimRadius, w, spokes) {
  const group = new Group();
  const hub = shadowed(new Mesh(new CylinderGeometry(rimRadius, rimRadius, w + 0.02, 20), rim));
  hub.rotation.x = Math.PI / 2;
  group.add(hub);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    group.add(box(0.05, 0.05, w + 0.05, damperMat, Math.cos(a) * rimRadius * 0.52, Math.sin(a) * rimRadius * 0.52, 0));
  }
  if (spokes) {
    for (let i = 0; i < 3; i++) {
      const spoke = box(rimRadius * 1.9, 0.045, w + 0.04, damperMat, 0, 0, 0);
      spoke.rotation.z = (i / 3) * Math.PI;
      group.add(spoke);
    }
  }
  return group;
}

function createTyre() {
  const group = new Group();
  const r = CAR.wheelRadius;
  const w = CAR.wheelWidth;
  const body = shadowed(new Mesh(new CylinderGeometry(r, r, w, 28), tyre));
  body.rotation.x = Math.PI / 2;
  group.add(body);
  // Chunky tread blocks so wheel rotation is easy to see.
  const blocks = 16;
  for (let i = 0; i < blocks; i++) {
    const a = (i / blocks) * Math.PI * 2;
    const b = box(0.11, 0.05, w * 0.92, tyre, Math.cos(a) * r, Math.sin(a) * r, (i % 2 ? 0.03 : -0.03));
    b.rotation.z = a + Math.PI / 2;
    group.add(b);
  }
  group.add(createRim(r * 0.58, w, false));
  return group;
}

// Coil spring of unit length along +y, scaled along y to match the shock length.
function createSpringGeometry() {
  const turns = 7;
  const points = [];
  for (let i = 0; i <= turns * 16; i++) {
    const t = i / (turns * 16);
    const a = t * turns * Math.PI * 2;
    points.push(new Vector3(Math.cos(a) * 0.075, t, Math.sin(a) * 0.075));
  }
  return new TubeGeometry(new CatmullRomCurve3(points), turns * 16, 0.014, 6, false);
}
const springGeometry = createSpringGeometry();

// One corner of the car: steered, spinning wheel, coil-over shock, and two control arms.
// With soft tyres the rig only carries the rim; the tyre is its own world-space mesh.
export function createWheelRig(index, { softTire = null } = {}) {
  const mount = wheelMount(index);
  const side = Math.sign(mount.z);
  const w = CAR.wheelWidth;

  const root = new Group();

  // The hub carries the wheel; it moves up and down with the suspension.
  const hub = new Group();
  const steer = new Group();
  // The spinning wheel's parts never move relative to each other: one mesh per material.
  const spin = mergeByMaterial(softTire ? createRim(softTire.rimRadius, softTire.width * 0.85, true) : createTyre());
  steer.add(spin);
  // Knuckle stays with the steering but not the spin.
  steer.add(box(0.14, 0.26, 0.08, frame, 0, 0, -side * (w / 2 + 0.06)));
  hub.add(steer);
  root.add(hub);

  // Chassis-side pick-up points (fixed).
  // Mounting points on the frame and cage (shared with the cage builder).
  const mounts = suspensionMounts(index);
  const P = (p) => new Vector3(p.x, p.y, p.z);
  const shockTop = P(mounts.shockTop);
  const upperPivot = P(CAR.solidAxles ? mounts.upperLinkFrame : mounts.upperArmFrame);
  const lowerPivot = P(CAR.solidAxles ? mounts.lowerLinkFrame : mounts.lowerArmFrame);

  const shock = new Group();
  const damperBody = shadowed(new Mesh(new CylinderGeometry(0.045, 0.045, 1, 10), damperMat));
  damperBody.position.y = 0.5;
  const damperBodyPivot = new Group();
  damperBodyPivot.add(damperBody);
  const shaft = shadowed(new Mesh(new CylinderGeometry(0.018, 0.018, 1, 8), chrome));
  shaft.position.y = 0.5;
  const shaftPivot = new Group();
  shaftPivot.add(shaft);
  const spring = shadowed(new Mesh(springGeometry, springMat));
  shock.add(damperBodyPivot, shaftPivot, spring);
  root.add(shock);

  const upperArm = shadowed(new Mesh(new BoxGeometry(1, 0.05, 0.07), frame));
  const lowerArm = shadowed(new Mesh(new BoxGeometry(1, 0.06, 0.09), frame));
  root.add(upperArm, lowerArm);

  return {
    object: root,
    hub,
    steer,
    spin,
    shock,
    damperBodyPivot,
    shaftPivot,
    spring,
    upperArm,
    lowerArm,
    shockTop,
    upperPivot,
    lowerPivot,
    solid: CAR.solidAxles,
    side,
    mount,
  };
}
