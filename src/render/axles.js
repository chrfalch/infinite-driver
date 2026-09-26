import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three/webgpu';
import { CAR } from '../vehicle/config.js';
import { rimInnerFace } from './wheel-inset.js';

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
  // Universal joints are too small for a visible shadow: skip them in the shadow pass.
  const jointA = shadowed(new Mesh(new BoxGeometry(0.08, 0.06, 0.08), jointMat));
  jointA.castShadow = false;
  const jointB = jointA.clone();
  return { pivot, spinner, jointA, jointB };
}

// Beam axles front and rear, a transfer case under the frame, and propshafts to each
// differential. Everything is placed from the live hub positions, so it follows suspension travel
// and any change of track, wheelbase, or ride height.
export function createAxleRig() {
  const group = new Group();
  group.name = 'axles';
  // Steering: shaft from the column through two universal joints to the steering box, pitman arm,
  // drag link to the left knuckle, tie rod between the knuckles.
  const steering = {
    upperShaft: unitCylinder(0.016, shaftMat, 8),
    lowerShaft: unitCylinder(0.016, shaftMat, 8),
    joints: [0, 1].map(() => {
      const joint = shadowed(new Mesh(new SphereGeometry(0.032, 12, 8), jointMat));
      joint.castShadow = false; // too small for a visible shadow
      return joint;
    }),
    box: shadowed(new Mesh(new BoxGeometry(0.16, 0.12, 0.12), housing)),
    pitman: unitCylinder(0.018, jointMat, 8),
    dragLink: unitCylinder(0.02, shaftMat, 8),
    tieRod: unitCylinder(0.02, shaftMat, 8),
    arms: [0, 1].map(() => unitCylinder(0.02, jointMat, 8)),
  };
  group.add(steering.upperShaft, steering.lowerShaft, steering.box, steering.pitman, steering.dragLink, steering.tieRod, ...steering.joints, ...steering.arms);
  const front = createAxle();
  const rear = createAxle();
  const transfer = shadowed(new Mesh(new BoxGeometry(0.34, 0.2, 0.26), housing));
  const frontShaft = createShaft();
  const rearShaft = createShaft();
  group.add(front.group, rear.group, transfer, frontShaft.pivot, rearShaft.pivot);
  group.add(frontShaft.jointA, frontShaft.jointB, rearShaft.jointA, rearShaft.jointB);
  return { group, front, rear, transfer, frontShaft, rearShaft, steering, angles: [0, 0] };
}

// hubs: chassis-local hub centres in wheel order FL, FR, RL, RR. shaftSpin: [front, rear]
// propshaft speeds in rad/s.
// steerQuats: chassis-local knuckle rotations of the front wheels; geometry: steeringGeometry().
export function updateAxleRig(rig, hubs, shaftSpin, dt, steerQuats = null, geometry = null, steer = 0) {
  const { y: hy } = CAR.halfExtents;
  const inset = rimInnerFace() + 0.03;
  // Transfer case hangs under the frame, a little behind the middle.
  rig.transfer.position.set(-0.1, -hy - 0.08, 0.12);
  rig.angles ??= [0, 0];
  rig.angles[0] += shaftSpin[0] * dt;
  rig.angles[1] += shaftSpin[1] * dt;

  for (const [axle, left, right, shaft, angle] of [
    [rig.front, hubs[0], hubs[1], rig.frontShaft, rig.angles[0]],
    [rig.rear, hubs[2], hubs[3], rig.rearShaft, rig.angles[1]],
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
    shaft.spinner.rotation.y = angle;
    shaft.jointA.position.copy(output);
    shaft.jointB.position.copy(input);
    shaft.jointA.rotation.x = angle;
    shaft.jointB.rotation.x = angle;
  }

  if (steerQuats && geometry) updateSteering(rig.steering, hubs, steerQuats, geometry, steer);
}

const tipA = new Vector3();

// Knuckle steering arms point back and inward from each front hub; they turn with the knuckle.
function updateSteering(st, hubs, steerQuats, geo, steer) {
  const tips = [];
  for (const [k, i] of [
    [0, 0],
    [1, 1],
  ]) {
    const hub = hubs[i];
    const side = Math.sign(hub.z) || (i === 0 ? -1 : 1);
    const arm = new Vector3(-0.2, -0.04, -side * 0.12).applyQuaternion(steerQuats[k]);
    const base = new Vector3(hub.x, hub.y - 0.02, hub.z - side * (rimInnerFace() + 0.02));
    const tip = base.clone().add(arm);
    place(st.arms[k], base, tip);
    tips.push(tip);
  }
  place(st.tieRod, tips[0], tips[1]);

  // Steering box on the frame; the pitman arm swings fore and aft with the steering.
  st.box.position.copy(geo.box);
  const pitmanTip = tipA.set(geo.box.x + Math.sin(steer * 1.6) * 0.16, geo.box.y - 0.17, geo.box.z);
  place(st.pitman, geo.box, pitmanTip);
  place(st.dragLink, pitmanTip, tips[0]);

  // Intermediate shaft between the two universal joints, then the box's short input shaft.
  place(st.upperShaft, geo.joint1, geo.joint2);
  place(st.lowerShaft, geo.joint2, geo.box);
  st.joints[0].position.copy(geo.joint1);
  st.joints[1].position.copy(geo.joint2);
}
