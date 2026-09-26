import {
  CameraTarget,
  IsPlayer,
  Physics,
  Render,
  RigidBody,
  AxleRig,
  SoftTireView,
  SteeringWheel,
  Transform,
  Vehicle,
  View,
  WheelOf,
  WheelRig,
} from '../ecs/traits.js';
import { createCarMesh, createWheelRig } from '../render/car-mesh.js';
import { createSoftTireMesh } from '../render/soft-tire-mesh.js';
import { CONTROLS } from '../controls.js';
import { effectiveGpuTire, effectiveTire, GPU_TIRE, TIRE } from '../tire/config.js';
import { createGpuTires } from '../tire/gpu-tires.js';
import { CAR, DRIVETRAIN } from './config.js';
import { Drivetrain } from './drivetrain.js';
import { createCarBody, WHEELS } from './physics.js';
import { createSoftCarBody, softCarRideHeight } from './soft-vehicle.js';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const ZERO = { x: 0, y: 0, z: 0 };

// Builds the player car (physics body, controller, meshes, wheel entities) from the current CAR settings.
export function spawnCar(world, { position, rotation = IDENTITY, linvel = ZERO, angvel = ZERO, steer = 0, drivetrain = null }) {
  const { rapier, world: physicsWorld } = world.get(Physics);
  const { scene } = world.get(Render);

  const soft = CAR.softTires;
  const device = world.get(Render).renderer?.backend?.device;
  const useGpu = soft && CAR.gpuTires && !!device;
  const tire = effectiveTire(TIRE, CONTROLS.performance);
  let gpuTires = null;
  if (useGpu) {
    const gpu = effectiveGpuTire(GPU_TIRE, CONTROLS.performance);
    gpuTires = createGpuTires(device, WHEELS.length, TIRE, gpu);
    gpuTires.solver.setParams(gpu, world.get(Physics).step);
  }
  const { body, controller } = soft
    ? createSoftCarBody(rapier, physicsWorld, position, CAR, tire, { gpuTires })
    : createCarBody(rapier, physicsWorld, position);
  body.setRotation(rotation, true);
  body.setLinvel(linvel, true);
  body.setAngvel(angvel, true);

  const { object, steeringWheel, axles } = createCarMesh();
  scene.add(object);
  const car = world.spawn(
    IsPlayer,
    CameraTarget,
    Transform({ position: { ...position }, quaternion: { ...rotation } }),
    RigidBody({ body }),
    // The drivetrain reads DRIVETRAIN live, so panel changes apply without a rebuild.
    Vehicle({ controller, body, drivetrain: drivetrain ?? new Drivetrain(DRIVETRAIN), steer, speed: 0 }),
    View({ object }),
    SteeringWheel({ object: steeringWheel }),
    AxleRig({ rig: axles }),
  );
  WHEELS.forEach((_, index) => {
    const rig = createWheelRig(index, { softTire: soft ? TIRE : null });
    object.add(rig.object);
    const wheel = world.spawn(WheelOf(car, { index }), WheelRig({ rig }));
    if (gpuTires) {
      const mesh = controller.wheels[index].mount.z > 0 ? gpuTires.mirrored : gpuTires.mesh;
      const tireObject = createSoftTireMesh(null, mesh);
      scene.add(tireObject);
      wheel.add(SoftTireView({ soft: null, gpu: gpuTires.solver, index, object: tireObject }));
    } else if (soft) {
      const softBody = controller.wheels[index].soft;
      const tireObject = createSoftTireMesh(softBody, controller.wheels[index].mesh);
      scene.add(tireObject);
      wheel.add(SoftTireView({ soft: softBody, object: tireObject }));
    }
  });
  return car;
}

function disposeObject(object) {
  object.traverse((child) => child.geometry?.dispose());
}

export function despawnCar(world, car) {
  const { world: physicsWorld } = world.get(Physics);
  const { scene } = world.get(Render);
  const { controller, body } = car.get(Vehicle);
  const { object } = car.get(View);

  world.query(WheelOf(car)).forEach((wheel) => {
    if (wheel.has(SoftTireView)) {
      const view = wheel.get(SoftTireView);
      scene.remove(view.object);
      view.object.geometry.dispose();
    }
    wheel.destroy();
  });
  // The jointed car owns its hubs, joints, and soft tyres; the raycast car is one controller.
  if (controller.dispose) controller.dispose();
  else physicsWorld.removeVehicleController(controller);
  physicsWorld.removeRigidBody(body);
  scene.remove(object);
  disposeObject(object);
  car.destroy();
}

// Rebuilds the car in place, keeping its motion, so geometry and mass changes apply live.
export function rebuildCar(world) {
  const car = world.queryFirst(IsPlayer, Vehicle);
  if (!car) return null;
  const { body, steer, drivetrain } = car.get(Vehicle);
  const state = {
    drivetrain,
    position: { ...body.translation() },
    rotation: { ...body.rotation() },
    linvel: { ...body.linvel() },
    angvel: { ...body.angvel() },
    steer,
  };
  despawnCar(world, car);
  return spawnCar(world, state);
}

// How high to place a new car so it drops gently onto its wheels.
export function startHeight() {
  return CAR.softTires ? softCarRideHeight() + 0.15 : 1.5;
}

// Puts the car back on its wheels a little above the ground where it is.
export function respawnCar(world, heightAt) {
  const car = world.queryFirst(IsPlayer, Vehicle);
  if (!car) return null;
  const { body } = car.get(Vehicle);
  const p = body.translation();
  const q = body.rotation();
  // Keep only the heading.
  const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
  despawnCar(world, car);
  return spawnCar(world, {
    position: { x: p.x, y: heightAt(p.x, p.z) + startHeight(), z: p.z },
    rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
  });
}
