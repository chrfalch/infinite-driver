import {
  CameraTarget,
  IsPlayer,
  Physics,
  Render,
  RigidBody,
  SteeringWheel,
  Transform,
  Vehicle,
  View,
  WheelOf,
  WheelRig,
} from '../ecs/traits.js';
import { createCarMesh, createWheelRig } from '../render/car-mesh.js';
import { createCarBody, WHEELS } from './physics.js';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const ZERO = { x: 0, y: 0, z: 0 };

// Builds the player car (physics body, controller, meshes, wheel entities) from the current CAR settings.
export function spawnCar(world, { position, rotation = IDENTITY, linvel = ZERO, angvel = ZERO, steer = 0 }) {
  const { rapier, world: physicsWorld } = world.get(Physics);
  const { scene } = world.get(Render);

  const { body, controller } = createCarBody(rapier, physicsWorld, position);
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
    const rig = createWheelRig(index);
    object.add(rig.object);
    world.spawn(WheelOf(car, { index }), WheelRig({ rig }));
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

  world.query(WheelOf(car)).forEach((wheel) => wheel.destroy());
  physicsWorld.removeVehicleController(controller);
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
    position: { x: p.x, y: heightAt(p.x, p.z) + 1.5, z: p.z },
    rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
  });
}
