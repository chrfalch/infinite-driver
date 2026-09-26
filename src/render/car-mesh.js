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

export const paint = new MeshStandardMaterial({ color: '#d9683f', roughness: 0.55, metalness: 0.05 });
const frame = new MeshStandardMaterial({ color: '#2d2f31', roughness: 0.7, metalness: 0.3 });
const cage = new MeshStandardMaterial({ color: '#3a3c3e', roughness: 0.5, metalness: 0.5 });
const seat = new MeshStandardMaterial({ color: '#4a4136', roughness: 0.9 });
const tyre = new MeshStandardMaterial({ color: '#232221', roughness: 0.95 });
const rim = new MeshStandardMaterial({ color: '#c9c6bd', roughness: 0.4, metalness: 0.6 });
const springMat = new MeshStandardMaterial({ color: '#e8c547', roughness: 0.4, metalness: 0.4 });
const damperMat = new MeshStandardMaterial({ color: '#1d1d1d', roughness: 0.4, metalness: 0.6 });
const chrome = new MeshStandardMaterial({ color: '#d7d7d7', roughness: 0.2, metalness: 0.9 });
const lamp = new MeshStandardMaterial({ color: '#fff4d6', emissive: '#fff1c2', emissiveIntensity: 0.7 });
const tail = new MeshStandardMaterial({ color: '#9e1c1c', emissive: '#7a0f0f', emissiveIntensity: 0.5 });

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

// Chassis-local: +x forward, +y up, +z right. Origin is the physics body origin.
export function createCarMesh() {
  const { x: hx, y: hy, z: hz } = CAR.halfExtents;
  const car = new Group();

  // Ladder frame rails, visible between the wheels.
  car.add(box(hx * 2.05, 0.12, 0.1, frame, 0, -hy + 0.02, -0.45));
  car.add(box(hx * 2.05, 0.12, 0.1, frame, 0, -hy + 0.02, 0.45));

  // Body tub, lifted off the frame.
  const tubBottom = -hy + 0.12;
  car.add(box(hx * 1.9, 0.5, hz * 2, paint, -0.05, tubBottom + 0.25, 0));
  // Bonnet sloping a touch lower at the front.
  car.add(box(1.05, 0.14, hz * 1.9, paint, hx - 0.62, tubBottom + 0.55, 0));
  // Shock towers on the tub sides, where the coil-overs mount.
  for (let i = 0; i < 4; i++) {
    const m = wheelMount(i);
    const tx = m.x + (m.x > 0 ? -0.12 : 0.12);
    car.add(box(0.16, 0.34, 0.14, frame, tx, m.y + 0.36, Math.sign(m.z) * (hz + 0.05)));
  }
  // Windscreen frame.
  const wsX = hx - 1.2;
  car.add(bar(new Vector3(wsX, tubBottom + 0.5, -hz + 0.05), new Vector3(wsX - 0.12, tubBottom + 1.05, -hz + 0.05), 0.035, cage));
  car.add(bar(new Vector3(wsX, tubBottom + 0.5, hz - 0.05), new Vector3(wsX - 0.12, tubBottom + 1.05, hz - 0.05), 0.035, cage));
  car.add(bar(new Vector3(wsX - 0.12, tubBottom + 1.05, -hz + 0.05), new Vector3(wsX - 0.12, tubBottom + 1.05, hz - 0.05), 0.035, cage));

  // Roll cage over the open cab.
  const hoopX = -0.75;
  const top = tubBottom + 1.25;
  for (const z of [-hz + 0.08, hz - 0.08]) {
    car.add(bar(new Vector3(hoopX, tubBottom + 0.5, z), new Vector3(hoopX, top, z), 0.04, cage));
    car.add(bar(new Vector3(hoopX, top, z), new Vector3(wsX - 0.12, tubBottom + 1.05, z), 0.035, cage));
    car.add(bar(new Vector3(hoopX, top, z), new Vector3(-hx + 0.2, tubBottom + 0.5, z), 0.035, cage));
  }
  car.add(bar(new Vector3(hoopX, top, -hz + 0.08), new Vector3(hoopX, top, hz - 0.08), 0.04, cage));

  // Seats.
  for (const z of [-0.3, 0.3]) {
    car.add(box(0.45, 0.12, 0.42, seat, -0.35, tubBottom + 0.56, z));
    car.add(box(0.12, 0.5, 0.42, seat, -0.6, tubBottom + 0.8, z));
  }

  // Steering wheel on a column, driver on the left (-z).
  const steeringWheel = new Group();
  const ring = shadowed(new Mesh(new TorusGeometry(0.17, 0.022, 8, 24), frame));
  const spoke = box(0.3, 0.03, 0.03, frame, 0, 0, 0);
  const spoke2 = box(0.03, 0.3, 0.03, frame, 0, 0, 0);
  steeringWheel.add(ring, spoke, spoke2);
  const column = new Group();
  column.position.set(wsX - 0.35, tubBottom + 0.82, -0.3);
  // Tilt the wheel so it faces the driver.
  column.rotation.set(0, Math.PI / 2, 0);
  column.rotateX(-0.45);
  column.add(steeringWheel);
  car.add(column);

  // Lights, bumpers, spare tyre.
  car.add(box(0.14, 0.14, hz * 2.4, frame, hx + 0.02, -0.1, 0));
  car.add(box(0.14, 0.14, hz * 2.4, frame, -hx - 0.02, -0.1, 0));
  car.add(box(0.05, 0.14, 0.2, lamp, hx - 0.08, tubBottom + 0.44, -hz + 0.22));
  car.add(box(0.05, 0.14, 0.2, lamp, hx - 0.08, tubBottom + 0.44, hz - 0.22));
  car.add(box(0.05, 0.1, 0.18, tail, -hx - 0.03, tubBottom + 0.38, -hz + 0.2));
  car.add(box(0.05, 0.1, 0.18, tail, -hx - 0.03, tubBottom + 0.38, hz - 0.2));
  const spare = createTyre();
  spare.rotation.y = Math.PI / 2;
  spare.position.set(-hx - 0.22, tubBottom + 0.55, 0);
  car.add(spare);

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
  const spin = softTire ? createRim(softTire.rimRadius, softTire.width * 0.85, true) : createTyre();
  steer.add(spin);
  // Knuckle stays with the steering but not the spin.
  steer.add(box(0.14, 0.26, 0.08, frame, 0, 0, -side * (w / 2 + 0.06)));
  hub.add(steer);
  root.add(hub);

  // Chassis-side pick-up points (fixed).
  const inboardZ = side * (CAR.halfExtents.z - 0.05);
  const shockTop = new Vector3(mount.x + (mount.x > 0 ? -0.12 : 0.12), mount.y + 0.46, side * (CAR.halfExtents.z + 0.12));
  const upperPivot = new Vector3(mount.x, mount.y + 0.12, inboardZ);
  const lowerPivot = new Vector3(mount.x, mount.y - 0.16, inboardZ);

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
    side,
    mount,
  };
}
