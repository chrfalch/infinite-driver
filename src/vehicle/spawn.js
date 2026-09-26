import {
  CameraTarget,
  IsPlayer,
  Physics,
  Render,
  RigidBody,
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
import { TIRE } from '../tire/config.js';
import { CAR } from './config.js';
import { createCarBody, WHEELS } from './physics.js';
import { createSoftCarBody, softCarRideHeight } from './soft-vehicle.js';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const ZERO = { x: 0, y: 0, z: 0 };

// Builds the player car (physics body, controller, meshes, wheel entities) from the current CAR settings.
export function spawnCar(world, { position, rotation = IDENTITY, linvel = ZERO, angvel = ZERO, steer = 0 }) {
  const { rapier, world: physicsWorld } = world.get(Physics);
  const { scene } = world.get(Render);

  const soft = CAR.softTires;
  const { body, controller } = (soft ? createSoftCarBody : createCarBody)(rapier, physicsWorld, position);
  body.setRotation(rotation, true);
  body.setLinvel(linvel, true);
  body.setAngvel(angvel, true);

  const { object, steeringWheel } = createCarMesh();
  scene.add(object);
  const car = world.spawn(
    IsPlayer,
    CameraTarget,
    Transform({ position: { ...position }, quaternion: { ...rotation } }),
    RigidBody({ body }),
    Vehicle({ controller, body, steer, speed: 0 }),
    View({ object }),
    SteeringWheel({ object: steeringWheel }),
  );
  WHEELS.forEach((_, index) => {
    const rig = createWheelRig(index, { softTire: soft ? TIRE : null });
    object.add(rig.object);
    const wheel = world.spawn(WheelOf(car, { index }), WheelRig({ rig }));
    if (soft) {
      const tire = controller.wheels[index].soft;
      const tireObject = createSoftTireMesh(tire, controller.wheels[index].mesh);
      scene.add(tireObject);
      wheel.add(SoftTireView({ soft: tire, object: tireObject }));
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
  const { body, steer } = car.get(Vehicle);
  const state = {
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
