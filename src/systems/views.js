import { Vector3 } from 'three/webgpu';
import { SteeringWheel, Transform, Vehicle, View, WheelOf, WheelRig } from '../ecs/traits.js';
import { CAR } from '../vehicle/config.js';

export function syncViews(world) {
  world.query(Transform, View).updateEach(([transform, view]) => {
    const { position: p, quaternion: q } = transform;
    view.object.position.set(p.x, p.y, p.z);
    view.object.quaternion.set(q.x, q.y, q.z, q.w);
  });
}

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const a = new Vector3();
const b = new Vector3();
const dir = new Vector3();

// Stretches a unit-length part between two points along the given local axis.
function span(object, from, to, axis) {
  dir.subVectors(to, from);
  const length = dir.length();
  object.position.copy(from).addScaledVector(dir, 0.5);
  object.quaternion.setFromUnitVectors(axis, dir.divideScalar(length));
  return length;
}

// Wheels, arms, and shocks are children of the car view, placed from the suspension state.
export function syncWheels(world) {
  world.query(WheelOf('*'), WheelRig).forEach((entity) => {
    const car = entity.targetFor(WheelOf);
    const { index } = entity.get(WheelOf(car));
    const { controller } = car.get(Vehicle);
    const { rig } = entity.get(WheelRig);
    const { mount, side } = rig;

    const suspension = controller.wheelSuspensionLength(index) ?? CAR.suspensionRestLength;
    const hubY = mount.y - suspension;
    rig.hub.position.set(mount.x, hubY, mount.z);
    rig.steer.rotation.y = controller.wheelSteering(index) ?? 0;
    // Spin around the axle (local z). Forward rolling is a negative rotation about +z.
    rig.spin.rotation.z = -(controller.wheelRotation(index) ?? 0);

    // Control arms run from the frame to the inner face of the hub.
    const hubInnerZ = mount.z - side * (CAR.wheelWidth / 2 + 0.06);
    a.set(mount.x, hubY + 0.12, hubInnerZ);
    span(rig.upperArm, rig.upperPivot, a, X);
    b.set(mount.x, hubY - 0.12, hubInnerZ);
    span(rig.lowerArm, rig.lowerPivot, b, X);

    // The shock sits on the lower arm, near the hub.
    a.lerpVectors(rig.lowerPivot, b, 0.72);
    a.y += 0.04;
    dir.subVectors(rig.shockTop, a);
    const length = dir.length();
    rig.shock.position.copy(a);
    rig.shock.quaternion.setFromUnitVectors(Y, dir.divideScalar(length));
    const bodyLength = Math.min(0.34, length * 0.7);
    rig.damperBodyPivot.position.y = length - bodyLength;
    rig.damperBodyPivot.scale.y = bodyLength;
    rig.shaftPivot.scale.y = length;
    rig.spring.position.y = 0.05;
    rig.spring.scale.y = Math.max(0.05, length - 0.12);
  });

  world.query(Vehicle, SteeringWheel).updateEach(([vehicle, wheel]) => {
    // The column faces forward, so a left turn (positive steer) is a negative roll about its z.
    wheel.object.rotation.z = -vehicle.steer * CAR.steeringWheelRatio;
  });
}
