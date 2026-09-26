import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three/webgpu';
import { CAR } from '../vehicle/config.js';

const housing = new MeshStandardMaterial({ color: '#34373a', roughness: 0.55, metalness: 0.5 });
const shaftMat = new MeshStandardMaterial({ color: '#8d8f91', roughness: 0.35, metalness: 0.8 });
const jointMat = new MeshStandardMaterial({ color: '#1f2123', roughness: 0.6, metalness: 0.4 });

const Y = new Vector3(0, 1, 0);
const a = new Vector3();
const b = new Vector3();
const dir = new Vector3();

function shadowed(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// A unit-length part along +y, stretched and aimed between two points by `place`.
function unitCylinder(radius, material, segments = 10) {
  const mesh = shadowed(new Mesh(new CylinderGeometry(radius, radius, 1, segments), material));
  const pivot = new Group();
  pivot.add(mesh);
  return pivot;
}

function place(pivot, from, to) {
  dir.subVectors(to, from);
  const length = dir.length();
  pivot.position.copy(from).addScaledVector(dir, 0.5);
  pivot.quaternion.setFromUnitVectors(Y, dir.divideScalar(length || 1));
  pivot.scale.set(1, length, 1);
}

// One beam axle: a housing between the two hubs with a differential in the middle.
function createAxle() {
  const group = new Group();
  const beamLeft = unitCylinder(0.055, housing);
  const beamRight = unitCylinder(0.055, housing);
  const diff = new Group();
  const pumpkin = shadowed(new Mesh(new SphereGeometry(0.15, 16, 12), housing));
  pumpkin.scale.set(1, 0.9, 0.85);
  const cover = shadowed(new Mesh(new CylinderGeometry(0.11, 0.11, 0.05, 16), jointMat));
  cover.rotation.z = Math.PI / 2;
  cover.position.x = 0;
  diff.add(pumpkin, cover);
  group.add(beamLeft, beamRight, diff);
  return { group, beamLeft, beamRight, diff, cover };
}

// Propshaft with a flat bar and universal joints, so its spin is visible.
function createShaft() {
  const pivot = new Group();
  const tube = shadowed(new Mesh(new CylinderGeometry(0.035, 0.035, 1, 10), shaftMat));
  const spinner = new Group();
  spinner.add(tube);
  const flat = shadowed(new Mesh(new BoxGeometry(0.075, 0.9, 0.02), jointMat));
  spinner.add(flat);
  pivot.add(spinner);
  const jointA = shadowed(new Mesh(new BoxGeometry(0.08, 0.06, 0.08), jointMat));
  const jointB = jointA.clone();
  return { pivot, spinner, jointA, jointB };
}

// Beam axles front and rear, a transfer case under the frame, and propshafts to each
// differential. Everything is placed from the live hub positions, so it follows suspension travel
// and any change of track, wheelbase, or ride height.
export function createAxleRig() {
  const group = new Group();
  group.name = 'axles';
  const front = createAxle();
  const rear = createAxle();
  const transfer = shadowed(new Mesh(new BoxGeometry(0.34, 0.2, 0.26), housing));
  const frontShaft = createShaft();
  const rearShaft = createShaft();
  group.add(front.group, rear.group, transfer, frontShaft.pivot, rearShaft.pivot);
  group.add(frontShaft.jointA, frontShaft.jointB, rearShaft.jointA, rearShaft.jointB);
  return { group, front, rear, transfer, frontShaft, rearShaft, angle: 0 };
}

// hubs: chassis-local hub centres in wheel order FL, FR, RL, RR. shaftSpin: propshaft rad/s.
export function updateAxleRig(rig, hubs, shaftSpin, dt) {
  const { y: hy } = CAR.halfExtents;
  const inset = CAR.wheelWidth / 2 + 0.08;
  // Transfer case hangs under the frame, a little behind the middle.
  rig.transfer.position.set(-0.1, -hy - 0.08, 0.12);
  rig.angle += shaftSpin * dt;

  for (const [axle, left, right, shaft] of [
    [rig.front, hubs[0], hubs[1], rig.frontShaft],
    [rig.rear, hubs[2], hubs[3], rig.rearShaft],
  ]) {
    // Housing ends just inboard of each wheel.
    a.set(left.x, left.y, left.z + inset);
    b.set(right.x, right.y, right.z - inset);
    const mid = new Vector3().addVectors(a, b).multiplyScalar(0.5);
    // Differential sits off-centre toward the driveshaft side, like most 4x4s.
    const diffPos = mid.clone().lerp(b, 0.12);
    place(axle.beamLeft, a, diffPos);
    place(axle.beamRight, diffPos, b);
    axle.diff.position.copy(diffPos);
    // Tilt the pumpkin with the beam.
    dir.subVectors(b, a).normalize();
    axle.diff.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), dir);

    // Propshaft from the transfer case to the differential input (facing the transfer case).
    const toCase = Math.sign(rig.transfer.position.x - diffPos.x);
    const input = diffPos.clone().add(new Vector3(toCase * 0.16, 0.02, 0));
    const output = rig.transfer.position.clone().add(new Vector3(-toCase * 0.17, -0.02, 0));
    place(shaft.pivot, output, input);
    shaft.pivot.scale.set(1, 1, 1);
    shaft.spinner.scale.set(1, output.distanceTo(input), 1);
    shaft.spinner.rotation.y = rig.angle;
    shaft.jointA.position.copy(output);
    shaft.jointB.position.copy(input);
    shaft.jointA.rotation.x = rig.angle;
    shaft.jointB.rotation.x = rig.angle;
  }
}
