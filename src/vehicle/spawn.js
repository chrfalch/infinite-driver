import {
  CameraTarget,
  IsPlayer,
  Physics,
  Render,
  RigidBody,
  RockField,
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
import { createGpuTires, gpuTireMeshes } from '../tire/gpu-tires.js';
import { CAR, DRIVETRAIN } from './config.js';
import { Drivetrain } from './drivetrain.js';
import { createCarBody, WHEELS } from './physics.js';
import { createSoftCarBody, softCarRideHeight } from './soft-vehicle.js';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const ZERO = { x: 0, y: 0, z: 0 };

// Builds the player car (physics body, controller, meshes, wheel entities) from the current CAR settings.
export function spawnCar(world, { position, rotation = IDENTITY, linvel = ZERO, angvel = ZERO, steer = 0, drivetrain = null }) {
  const { rapier, world: physicsWorld, remote } = world.get(Physics);
  // Physics in the worker: it simulates the car; here it is only drawn (see physics/client.js).
  if (remote) return spawnRemoteCar(world, remote, { position, rotation, linvel, angvel, steer, keepDrivetrain: !!drivetrain });

  const soft = CAR.softTires;
  const device = world.get(Render).renderer?.backend?.device;
  const useGpu = soft && CAR.gpuTires && !!device;
  const tire = effectiveTire(TIRE, CONTROLS.performance);
  let gpuTires = null;
  if (useGpu) {
    const gpu = effectiveGpuTire(GPU_TIRE, CONTROLS.performance);
    gpuTires = createGpuTires(device, WHEELS.length, TIRE, gpu);
    gpuTires.solver.setParams(gpu, world.get(Physics).step);
    gpuTires.pipelined = gpu.pipelined;
  }
  const { body, controller } = soft
    ? createSoftCarBody(rapier, physicsWorld, position, CAR, tire, { gpuTires, rotation, linvel, angvel })
    : createCarBody(rapier, physicsWorld, position);
  if (!soft) {
    body.setRotation(rotation, true);
    body.setLinvel(linvel, true);
    body.setAngvel(angvel, true);
  }

  return addCarViews(world, { body, controller, gpuTires, soft, drivetrain: drivetrain ?? new Drivetrain(DRIVETRAIN), position, rotation, steer });
}

function spawnRemoteCar(world, remote, { keepDrivetrain, ...pose }) {
  const { body, controller, drivetrain } = remote.spawn(pose, { keepDrivetrain });
  const gpu = effectiveGpuTire(GPU_TIRE, CONTROLS.performance);
  const gpuTires = { ...gpuTireMeshes(TIRE, gpu), solver: controller.gpu.solver };
  const car = addCarViews(world, { body, controller, gpuTires, soft: true, drivetrain, position: pose.position, rotation: pose.rotation, steer: pose.steer });
  // The worker's speed, steering, and brake state go into the entity's own Vehicle object.
  remote.attach(car.get(Vehicle));
  return car;
}

// The player entity, its meshes, and one entity per wheel.
function addCarViews(world, { body, controller, gpuTires, soft, drivetrain, position, rotation, steer }) {
  const { scene } = world.get(Render);
  const { object, steeringWheel, axles } = createCarMesh();
  scene.add(object);
  const car = world.spawn(
    IsPlayer,
    CameraTarget,
    Transform({ position: { ...position }, quaternion: { ...rotation } }),
    RigidBody({ body }),
    // The drivetrain reads DRIVETRAIN live, so panel changes apply without a rebuild.
    Vehicle({ controller, body, drivetrain, steer, speed: 0 }),
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
      // Each tyre has its own material and lattice/rock textures (see render/mt-tyre.js).
      view.object.userData.lattice?.dispose();
      view.object.userData.rocks?.dispose();
      view.object.material?.dispose();
    }
    wheel.destroy();
  });
  // The jointed car owns its hubs, joints, and soft tyres; the raycast car is one controller.
  if (controller.dispose) controller.dispose();
  else physicsWorld.removeVehicleController(controller);
  physicsWorld?.removeRigidBody(body);
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
  // Just above ride height, so the car settles instead of landing.
  return CAR.softTires ? softCarRideHeight() + 0.03 : 1.5;
}

// Puts the car back on its wheels a little above the ground where it is.
export function respawnCar(world, heightAt) {
  const car = world.queryFirst(IsPlayer, Vehicle);
  if (!car) return null;
  const { body } = car.get(Vehicle);
  const p = body.translation();
  const q = body.rotation();
  // Keep only the heading: the car's forward axis (+x) projected onto the ground. This also
  // works when the car lies on its side or roof.
  const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
  const fz = 2 * (q.x * q.z - q.w * q.y);
  const yaw = Math.hypot(fx, fz) > 1e-3 ? Math.atan2(-fz, fx) : 0;
  const spot = findSpawnSpot(world, heightAt, p.x, p.z, yaw);
  return respawnCarAt(world, heightAt, spot.x, spot.z, spot.yaw);
}

// Car footprint for spawn checks: half length (bumper to rear hoop) and half width over the tyres.
const HALF_LENGTH = 2.5;
const HALF_WIDTH = 1.25;

// Heights over the car's footprint at (x, z) facing yaw: corners, edge midpoints and centre.
function footprint(heightAt, x, z, yaw) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const hs = [];
  for (const a of [-1, 0, 1]) {
    for (const b of [-1, 0, 1]) {
      const lx = a * HALF_LENGTH;
      const lz = b * HALF_WIDTH;
      // Local +x is forward (world (cos, -sin) for a yaw about +y), local +z to the right.
      hs.push(heightAt(x + lx * c + lz * s, z - lx * s + lz * c));
    }
  }
  return { min: Math.min(...hs), max: Math.max(...hs) };
}

// Rocks and tree trunks near a point, from the loaded terrain chunks.
function obstaclesNear(world, x, z, radius) {
  const out = [];
  world.query(RockField).forEach((e) => {
    const field = e.get(RockField);
    for (const r of field.rocks) if (Math.hypot(r.x - x, r.z - z) < radius) out.push({ x: r.x, z: r.z, r: r.size * 1.2 });
    for (const p of field.plants ?? []) {
      if (p.kind === 'tree' && Math.hypot(p.x - x, p.z - z) < radius) out.push({ x: p.x, z: p.z, r: 0.5 });
    }
  });
  return out;
}

// A good place to put the car back on its wheels near (x, z): on the nearest road if the terrain
// has roads, otherwise the nearest level patch, clear of rocks and trees. The car faces along the
// road (whichever way is closer to its old heading). Falls back to the old spot.
export function findSpawnSpot(world, heightAt, x0, z0, yaw0) {
  const level = (x, z, yaw) => {
    const f = footprint(heightAt, x, z, yaw);
    return f.max - f.min < 0.35;
  };
  const clear = (x, z) => obstaclesNear(world, x, z, 6).every((o) => Math.hypot(o.x - x, o.z - z) > o.r + HALF_LENGTH + 0.3);
  const facing = (h) => {
    const d = Math.atan2(Math.sin(h - yaw0), Math.cos(h - yaw0));
    return Math.abs(d) <= Math.PI / 2 ? h : h + Math.PI;
  };
  // Walk onto the nearest road centre line: a few Newton steps down the road-distance field.
  const toRoad = (x, z) => {
    for (let i = 0; i < 8; i++) {
      const d = heightAt.roadDistance(x, z);
      if (d < 0.25) break;
      const e = 0.5;
      const gx = (heightAt.roadDistance(x + e, z) - heightAt.roadDistance(x - e, z)) / (2 * e);
      const gz = (heightAt.roadDistance(x, z + e) - heightAt.roadDistance(x, z - e)) / (2 * e);
      const g = Math.hypot(gx, gz) || 1;
      x -= (gx / g) * d;
      z -= (gz / g) * d;
    }
    return heightAt.roadDistance(x, z) < 1 ? { x, z } : null;
  };
  const roads = typeof heightAt.roadDistance === 'function';
  for (let ring = 0; ring <= 40; ring++) {
    const radius = ring * 6;
    const n = ring === 0 ? 1 : Math.min(48, 8 + ring * 4);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      let x = x0 + Math.cos(a) * radius;
      let z = z0 + Math.sin(a) * radius;
      let yaw = yaw0;
      if (roads) {
        const onRoad = toRoad(x, z);
        if (!onRoad) continue;
        ({ x, z } = onRoad);
        yaw = facing(heightAt.roadHeading(x, z));
      }
      if (level(x, z, yaw) && clear(x, z)) return { x, z, yaw };
    }
  }
  return { x: x0, z: z0, yaw: yaw0 };
}

// Puts the car on its wheels at (x, z), facing `yaw` (radians about +y; 0 faces +x).
export function respawnCarAt(world, heightAt, x, z, yaw = 0) {
  const car = world.queryFirst(IsPlayer, Vehicle);
  if (car) despawnCar(world, car);
  // Drop from just above the highest ground under the car, so no wheel starts inside a slope.
  const ground = footprint(heightAt, x, z, yaw).max;
  return spawnCar(world, {
    position: { x, y: ground + startHeight(), z },
    rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
  });
}

// Rebuilds and respawns destroy physics bodies and GPU buffers, so they must not run while a
// physics step is awaiting the GPU. UI code queues them here; the frame loop applies them at the
// start of the next frame, before physics.
let pendingAction = null;

export function requestRebuild(world) {
  if (pendingAction?.type !== 'respawn') pendingAction = { type: 'rebuild', world };
}

export function requestRespawn(world, heightAt) {
  pendingAction = { type: 'respawn', world, heightAt };
}

// Test and debug hook: respawn at a given place and heading (see window.__game in main.js).
export function requestRespawnAt(world, heightAt, x, z, yaw) {
  pendingAction = { type: 'respawnAt', world, heightAt, x, z, yaw };
}

export function applyPendingCarAction() {
  const action = pendingAction;
  pendingAction = null;
  if (action?.type === 'rebuild') rebuildCar(action.world);
  if (action?.type === 'respawn') respawnCar(action.world, action.heightAt);
  if (action?.type === 'respawnAt') respawnCarAt(action.world, action.heightAt, action.x, action.z, action.yaw);
}
