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
import { createBeadlockWheel } from './beadlock-wheel.js';
import { LUG_HEIGHT, createStaticMtTyre } from './mt-tyre.js';
import { TIRE } from '../tire/config.js';
import { torusMesh } from '../tire/soft-tire.js';
import { createTubeChassis } from './tube-chassis.js';
import { mergeByMaterial } from './merge-geometry.js';
import { frameGeometry, suspensionMounts } from '../vehicle/frame-geometry.js';
import { rimInnerFace } from './wheel-inset.js';

const frame = new MeshStandardMaterial({ color: '#2d2f31', roughness: 0.7, metalness: 0.3 });
const seat = new MeshStandardMaterial({ color: '#4a4136', roughness: 0.9 });
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
// Wheel → column (rising toward the driver at 25°, the wheel square to it) → universal joint under
// the dash → intermediate shaft → universal joint → short input shaft → steering box inside the
// nose box, just behind the front axle. Each joint only takes a moderate angle.
export function steeringGeometry() {
  const tilt = (25 * Math.PI) / 180;
  const faceNormal = new Vector3(-Math.cos(tilt), Math.sin(tilt), 0); // up and back at the driver
  const wheelCenter = new Vector3(0.24, 0.24, -0.3);
  const columnAxis = faceNormal.clone().negate(); // from the wheel toward the dash
  const joint1 = wheelCenter.clone().addScaledVector(columnAxis, 0.5);
  const box = new Vector3(1.0, -0.28, -0.4);
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
// A sand buggy with no body panels: one welded tube chassis (see tube-chassis.js), bucket seats,
// steering, and running gear.
export function createCarMesh() {
  const g = frameGeometry();
  const car = new Group();
  // Parts fixed to the chassis go into `body`, merged into one mesh per material at the end.
  const body = new Group();
  body.name = 'tube chassis';
  body.add(createTubeChassis(0).group);

  // Bucket seats on the floor, driver on the left (-z): cushion, back, and side bolsters.
  for (const z of [-0.3, 0.3]) {
    body.add(box(0.46, 0.08, 0.4, seat, g.seatX, g.floorTop + 0.08, z));
    for (const side of [1, -1]) {
      const bolster = box(0.44, 0.1, 0.07, seat, g.seatX, g.floorTop + 0.14, z + side * 0.2);
      bolster.rotation.x = side * 0.25;
      body.add(bolster);
    }
    const back = box(0.08, 0.7, 0.4, seat, g.seatX - 0.27, g.floorTop + 0.43, z);
    back.rotation.z = 0.22;
    body.add(back);
    for (const side of [1, -1]) {
      const wing = box(0.1, 0.62, 0.06, seat, g.seatX - 0.24, g.floorTop + 0.4, z + side * 0.21);
      wing.rotation.z = 0.22;
      wing.rotation.x = side * 0.3;
      body.add(wing);
    }
    // Seat rails on the floor.
    for (const side of [1, -1]) body.add(box(0.4, 0.04, 0.04, frame, g.seatX, g.floorTop + 0.02, z + side * 0.15));
  }

  // Steering: the wheel faces the driver, tilted up and back; its column runs forward and down
  // through a bracket on the dash bar. The shaft to the steering box and the linkage to the front
  // axle are in the axle rig, which moves them with the steering.
  const steeringWheel = new Group();
  const ring = shadowed(new Mesh(new TorusGeometry(0.17, 0.018, 10, 36), frame));
  const hubCap = shadowed(new Mesh(new CylinderGeometry(0.035, 0.035, 0.05, 16), frame));
  hubCap.rotation.x = Math.PI / 2;
  steeringWheel.add(ring, hubCap);
  for (const a of [-Math.PI / 2, -Math.PI / 2 + (2 * Math.PI) / 3, -Math.PI / 2 - (2 * Math.PI) / 3]) {
    const spoke = box(0.15, 0.025, 0.012, frame, Math.cos(a) * 0.09, Math.sin(a) * 0.09, -0.01);
    spoke.rotation.z = a;
    steeringWheel.add(spoke);
  }
  mergeByMaterial(steeringWheel);
  const steer = steeringGeometry();
  const column = new Group();
  column.position.copy(steer.wheelCenter);
  // Face normal points up and back at the driver.
  column.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), steer.faceNormal);
  column.add(steeringWheel);
  car.add(column);
  // Column from the wheel to the first universal joint, held by a strap from the dash bar.
  body.add(bar(steer.wheelCenter, steer.joint1, 0.02, frame));
  const clamp = steer.wheelCenter.clone().lerp(steer.joint1, 0.76);
  body.add(bar(clamp, new Vector3(g.dash.x, g.dash.y, clamp.z), 0.012, frame));
  body.add(box(0.05, 0.05, 0.06, frame, clamp.x, clamp.y, clamp.z));
  car.add(mergeByMaterial(body));

  const axles = createAxleRig();
  car.add(axles.group);

  return { object: car, steeringWheel, axles };
}

// Rigid-wheel mode: a static mud-terrain tyre (the same tread as the soft tyres, built from the
// rest shape) on a beadlock wheel. `side` is the outboard direction.
function createTyre(side = 1) {
  const group = new Group();
  const shape = { ...TIRE, outerRadius: CAR.wheelRadius - LUG_HEIGHT, width: CAR.wheelWidth * 0.94, segmentsAround: 40, segmentsAcross: 10 };
  group.add(createStaticMtTyre(torusMesh(shape, { mirror: side > 0 })));
  group.add(createBeadlockWheel(shape.rimRadius, shape.width * 0.85, side));
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

  const root = new Group();

  // The hub carries the wheel; it moves up and down with the suspension.
  const hub = new Group();
  const steer = new Group();
  // The spinning wheel's parts never move relative to each other: one mesh per material.
  const spin = mergeByMaterial(softTire ? createBeadlockWheel(softTire.rimRadius, softTire.width * 0.85, side) : createTyre(side));
  steer.add(spin);
  // Knuckle stays with the steering but not the spin.
  steer.add(box(0.14, 0.26, 0.08, frame, 0, 0, -side * (rimInnerFace() + 0.02)));
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
