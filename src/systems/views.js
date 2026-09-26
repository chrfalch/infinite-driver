import { Vector3 } from 'three/webgpu';
import { AxleRig, IsPlayer, SoftTireView, SteeringWheel, Time, Transform, Vehicle, View, WheelOf, WheelRig } from '../ecs/traits.js';
import { updateAxleRig } from '../render/axles.js';
import { steeringGeometry } from '../render/car-mesh.js';
import { brakeLightMaterial } from '../render/tube-chassis.js';
import { DRIVETRAIN } from '../vehicle/config.js';
import { updateGpuTireMesh, updateSoftTireMesh } from '../render/soft-tire-mesh.js';
import { CAR } from '../vehicle/config.js';
import { ifsPoseFromHub } from '../vehicle/frame-geometry.js';

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
  // Unit-length cylinders (the double A-arm parts) are stretched to fit.
  if (axis === Y) object.scale.set(1, length, 1);
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

    let hubY;
    if (controller.wheelHubPose) {
      // Jointed car: copy the physics hub's pose so the rim stays inside its soft tyre.
      const { position: p, steer: s, spin: r } = controller.wheelHubPose(index);
      hubY = p.y;
      rig.hub.position.set(p.x, p.y, p.z);
      rig.steer.quaternion.set(s.x, s.y, s.z, s.w);
      rig.spin.quaternion.set(r.x, r.y, r.z, r.w);
    } else {
      const suspension = controller.wheelSuspensionLength(index) ?? CAR.suspensionRestLength;
      hubY = mount.y - suspension;
      rig.hub.position.set(mount.x, hubY, mount.z);
      rig.steer.rotation.y = controller.wheelSteering(index) ?? 0;
      // Spin around the axle (local z). Forward rolling is a negative rotation about +z.
      rig.spin.rotation.z = -(controller.wheelRotation(index) ?? 0);
    }

    if (rig.solid) {
      // 4-link: links run lengthwise from the frame brackets to the axle beam beside the hub, and
      // the coil-over stands on the axle under its top mount.
      a.set(mount.x, hubY + 0.13, rig.upperPivot.z);
      span(rig.upperArm, rig.upperPivot, a, X);
      b.set(mount.x, hubY - 0.1, rig.lowerPivot.z);
      span(rig.lowerArm, rig.lowerPivot, b, X);
      a.set(rig.shockTop.x, hubY + 0.06, rig.shockTop.z * 0.94);
    } else {
      // Double A-arms from the physics links (or, for the raycast car, moved with the hub).
      const pose = controller.suspensionPose?.(index) ?? ifsPoseFromHub(index, rig.hub.position);
      const f = rig.ifs;
      const V = (p, out) => out.set(p.x, p.y, p.z);
      const bj = V(pose.lowerBall, new Vector3());
      const ub = V(pose.upperBall, new Vector3());
      span(f.lower[0], V(pose.lowerInner[0], a), bj, Y);
      span(f.lower[1], V(pose.lowerInner[1], a), bj, Y);
      span(f.upper[0], V(pose.upperInner[0], a), ub, Y);
      span(f.upper[1], V(pose.upperInner[1], a), ub, Y);
      span(f.upright, bj, ub, Y);
      const to = V(pose.tieOuter, new Vector3());
      // Steering arm from the middle of the upright out to the tie rod end.
      span(f.steeringArm, a.lerpVectors(bj, ub, 0.5), to, Y);
      span(f.tieRod, V(pose.tieInner, b), to, Y);
      f.joints[0].position.copy(bj);
      f.joints[1].position.copy(ub);
      f.joints[2].position.copy(to);
      V(pose.tieInner, f.joints[3].position);
      V(pose.shockBottom, a);
      rig.shockTop.set(pose.shockTop.x, pose.shockTop.y, pose.shockTop.z);
    }
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
    // The wheel faces the driver (its +z points at them), so a left turn is a positive roll.
    wheel.object.rotation.z = vehicle.steer * CAR.steeringWheelRatio;
  });
}

// Brake lights: dim tail-light glow, bright red while braking (a quick fade, like a filament).
export function syncBrakeLights(world) {
  const vehicle = world.queryFirst(IsPlayer, Vehicle)?.get(Vehicle);
  if (!vehicle) return;
  const target = vehicle.braking ? 3.2 : 0.25;
  const k = Math.min(1, world.get(Time).delta / 0.06);
  brakeLightMaterial.emissiveIntensity += (target - brakeLightMaterial.emissiveIntensity) * k;
}

export function syncSoftTires(world) {
  world.query(SoftTireView).updateEach(([view]) => {
    if (view.gpu) {
      const hub = world.queryFirst(IsPlayer, Vehicle)?.get(Vehicle).controller.wheels?.[view.index]?.hub;
      updateGpuTireMesh(view.object, view.gpu, view.index, hub);
    }
    else updateSoftTireMesh(view.object, view.soft);
  });
}

// Axles and propshafts follow the hub positions set by syncWheels.
export function syncAxles(world) {
  const { delta } = world.get(Time);
  world.query(Vehicle, AxleRig).forEach((car) => {
    const hubs = [];
    const steerQuats = [];
    world.query(WheelOf(car), WheelRig).forEach((wheel) => {
      const { index } = wheel.get(WheelOf(car));
      const rig = wheel.get(WheelRig).rig;
      hubs[index] = rig.hub.position;
      if (index < 2) steerQuats[index] = rig.steer.quaternion;
    });
    if (hubs.length < 4 || hubs.includes(undefined)) return;
    const { controller, speed, steer } = car.get(Vehicle);
    // Each propshaft turns with its own axle's wheels (times the final drive), smoothed, and stops
    // dead below a crawl so measurement noise never turns a parked car's shafts.
    const radius = controller.tire?.outerRadius ?? CAR.wheelRadius;
    const spin = (i) => (controller.wheelSpin ? controller.wheelSpin(i) : speed / radius);
    const rig = car.get(AxleRig).rig;
    rig.axleSpin ??= [0, 0];
    const k = Math.min(1, delta / 0.1);
    const targets = [(spin(0) + spin(1)) / 2, (spin(2) + spin(3)) / 2];
    targets.forEach((w, a) => {
      rig.axleSpin[a] += (w - rig.axleSpin[a]) * k;
      if (Math.abs(rig.axleSpin[a] * radius) < 0.15) rig.axleSpin[a] = 0;
    });
    const wheelW = rig.axleSpin.map((w) => w * DRIVETRAIN.finalDrive);
    updateAxleRig(rig, hubs, wheelW, delta, steerQuats, steeringGeometry(), steer);
  });
}
