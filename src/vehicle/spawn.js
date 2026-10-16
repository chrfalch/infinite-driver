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
import { releaseMtTyreMesh } from '../render/mt-tyre.js';
import { createInstanceBatcher } from '../render/instance-batcher.js';
import { CONTROLS } from '../controls.js';
import { effectiveGpuTire, effectiveTire, GPU_TIRE, TIRE } from '../tire/config.js';
import { createGpuTires, gpuTireMeshes } from '../tire/gpu-tires.js';
import { CAR, DRIVETRAIN, playerTires } from './config.js';
import { Drivetrain } from './drivetrain.js';
import { createCarBody, WHEELS } from './physics.js';
import { createSoftCarBody, softCarRideHeight } from './soft-vehicle.js';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const ZERO = { x: 0, y: 0, z: 0 };

// Builds a car (physics body, controller, meshes, wheel entities) from the current CAR settings.
// Each car has its own tyre model, `tires` (see TIRE_MODES; the player's from CAR by default), so
// one car can run on the GPU tyre solver and the next on rigid wheels. The `player`'s car is the
// one the keyboard drives and the camera follows; another car is driven through its Vehicle's
// `input` (it stands still without one), by its AI `driver` if it has one (see systems/ai.js), and
// drawn in its own `livery`.
export function spawnCar(world, { position, rotation = IDENTITY, linvel = ZERO, angvel = ZERO, steer = 0, drivetrain = null, tires = playerTires(), player = true, livery = null, input = null, driver = null, slot = null }) {
  const { remote } = world.get(Physics);
  const spec = { tires, player, livery: player ? null : livery, input, driver, slot: slot ?? nextSlot(world, player) };
  // Physics in the worker: it simulates the car; here it is only drawn (see physics/client.js).
  // (A rebuild keeps the gearbox and engine state: the worker's, of the car it replaces.)
  if (remote) return spawnRemoteCar(world, remote, { position, rotation, linvel, angvel, steer, keepDrivetrain: drivetrain?.carId ?? 0 }, spec);

  const physics = createCarPhysics(world, { position, rotation, linvel, angvel }, tires);
  return addCarViews(world, { ...physics, drivetrain: drivetrain ?? new Drivetrain(DRIVETRAIN), position, rotation, steer, spec });
}

// Every car's place in the shared tyre-track mesh (see Tracks): the player's is 0, the others 1, 2, …
function nextSlot(world, player) {
  if (player) return 0;
  const taken = new Set();
  world.query(Vehicle).forEach((e) => taken.add(e.get(Vehicle).slot));
  let slot = 1;
  while (taken.has(slot)) slot++;
  return slot;
}

// A car's physics (body, controller, and GPU tyres) on this thread, for tyre model `tires`. Without
// a GPU device here the GPU tyres fall back to Rapier's soft bodies.
function createCarPhysics(world, { position, rotation = IDENTITY, linvel = ZERO, angvel = ZERO }, tires) {
  const { rapier, world: physicsWorld } = world.get(Physics);
  const soft = tires !== 'rigid';
  const device = world.get(Render).renderer?.backend?.device;
  const useGpu = tires === 'gpu' && !!device;
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
  return { body, controller, gpuTires, soft };
}

// Which kind of car the views were built for; a respawn keeps them only for the same kind.
const viewsKind = (remote, tires) => `${tires}|${remote ? 'worker' : 'local'}`;

function spawnRemoteCar(world, remote, { keepDrivetrain, ...pose }, spec) {
  const { id, body, controller, drivetrain } = remote.spawn(pose, { keepDrivetrain, tires: spec.tires, player: spec.player });
  const gpu = effectiveGpuTire(GPU_TIRE, CONTROLS.performance);
  const gpuTires = controller.gpu ? { ...gpuTireMeshes(TIRE, gpu), solver: controller.gpu.solver } : null;
  const car = addCarViews(world, { body, controller, gpuTires, soft: spec.tires !== 'rigid', drivetrain, position: pose.position, rotation: pose.rotation, steer: pose.steer, spec, id });
  // The worker's speed, steering, and brake state go into the entity's own Vehicle object.
  remote.attach(id, car.get(Vehicle));
  return car;
}

// The other cars draw cheaper (?rivaldetail=full draws them as the player's): no engine (116k
// triangles, mostly under the body) and only the body panels cast shadows. Each full car is ~300k
// triangles in ~180 meshes, nearly all in the shadow pass too, and its GPU time is taken from the
// GPU tyres' (the solver shares the GPU), so a pack of cars in view slowed the game down.
const FULL_RIVALS = new URLSearchParams(globalThis.location?.search ?? '').get('rivaldetail') === 'full';
function simplifyRivalView(object) {
  const engine = object.userData.engine;
  if (engine) {
    engine.object.visible = false;
    object.userData.engine = null;
  }
  // (The trophy body loads later, with its shadows as built.)
  object.traverse((o) => {
    if (o.isMesh) o.castShadow = false;
  });
}

// The car's entity, its meshes, and one entity per wheel.
function addCarViews(world, { body, controller, gpuTires, soft, drivetrain, position, rotation, steer, spec, id = 0 }) {
  const { scene } = world.get(Render);
  const { object, steeringWheel, axles } = createCarMesh({ livery: spec.livery, soft });
  scene.add(object);
  const car = world.spawn(
    Transform({ position: { ...position }, quaternion: { ...rotation } }),
    RigidBody({ body }),
    // The drivetrain reads DRIVETRAIN live, so panel changes apply without a rebuild.
    Vehicle({ controller, body, drivetrain, steer, speed: 0, tires: spec.tires, input: spec.input, driver: spec.driver, slot: spec.slot }),
    View({ object }),
    SteeringWheel({ object: steeringWheel }),
    AxleRig({ rig: axles }),
  );
  if (spec.player) car.add(IsPlayer, CameraTarget);
  // Its id: the worker's with worker physics, else the entity's.
  car.get(Vehicle).id = id || car.id();
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
  if (!spec.player && !FULL_RIVALS) simplifyRivalView(object);
  // The moving parts (arms, shocks, joints, shafts) repeat per wheel: draw each shape once, instanced.
  object.userData.batcher = createInstanceBatcher(object, scene);
  object.userData.kind = viewsKind(world.get(Physics).remote, spec.tires);
  object.userData.spec = spec;
  return car;
}

function disposeObject(object) {
  // Geometry shared between cars (the engine model) stays.
  object.traverse((child) => child.userData.sharedGeometry || child.geometry?.dispose());
  for (const material of object.userData.ownMaterials ?? []) material.dispose();
}

// Takes the car's physics out of its world (or the worker's).
function removeCarPhysics(world, vehicle) {
  const { remote, world: physicsWorld } = world.get(Physics);
  if (remote) return remote.despawn(vehicle.id);
  // The jointed car owns its hubs, joints, and soft tyres; the raycast car is one controller.
  if (vehicle.controller.dispose) vehicle.controller.dispose();
  else physicsWorld.removeVehicleController(vehicle.controller);
  physicsWorld.removeRigidBody(vehicle.body);
}

export function despawnCar(world, car) {
  const { scene } = world.get(Render);
  const { object } = car.get(View);

  world.query(WheelOf(car)).forEach((wheel) => {
    if (wheel.has(SoftTireView)) {
      const view = wheel.get(SoftTireView);
      scene.remove(view.object);
      // Each tyre has its own material and lattice/rock textures (see render/mt-tyre.js), kept for
      // the next car's tyres.
      releaseMtTyreMesh(view.object);
    }
    wheel.destroy();
  });
  removeCarPhysics(world, car.get(Vehicle));
  object.userData.batcher?.dispose();
  scene.remove(object);
  disposeObject(object);
  car.destroy();
}

// Rebuilds every car in place, keeping its motion, so geometry and mass changes apply live.
export function rebuildCars(world) {
  const cars = [];
  world.query(Vehicle, View).forEach((car) => cars.push(car));
  for (const car of cars) {
    const { body, steer, drivetrain, tires, input, driver, slot } = car.get(Vehicle);
    const { player, livery } = car.get(View).object.userData.spec;
    const state = {
      drivetrain,
      position: { ...body.translation() },
      rotation: { ...body.rotation() },
      linvel: { ...body.linvel() },
      angvel: { ...body.angvel() },
      steer,
    };
    despawnCar(world, car);
    // The player's car takes the tyre model the settings now ask for.
    spawnCar(world, { ...state, tires: player ? playerTires() : tires, player, livery, input, driver, slot });
  }
  return world.queryFirst(IsPlayer, Vehicle);
}

// How high to place a new car with tyre model `tires` so it drops gently onto its wheels.
export function startHeight(tires = playerTires()) {
  // Just above ride height, so the car settles instead of landing.
  return tires !== 'rigid' ? softCarRideHeight() + 0.03 : 1.5;
}

// Puts a car (the player's unless given) back on its wheels a little above the ground where it is.
export function respawnCar(world, heightAt, car = world.queryFirst(IsPlayer, Vehicle)) {
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
  return respawnCarAt(world, heightAt, spot.x, spot.z, spot.yaw, { car });
}

// Car footprint for spawn checks: half length (bumper to rear hoop) and half width over the tyres.
const HALF_LENGTH = 2.5;
const HALF_WIDTH = 1.25;

// Heights over the car's footprint at (x, z) facing yaw: corners, edge midpoints and centre.
export function footprint(heightAt, x, z, yaw) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const hs = [];
  // A 5 x 5 grid, fine enough for the dry river's rock humps.
  for (const a of [-1, -0.5, 0, 0.5, 1]) {
    for (const b of [-1, -0.5, 0, 0.5, 1]) {
      const lx = a * HALF_LENGTH;
      const lz = b * HALF_WIDTH;
      // Local +x is forward (world (cos, -sin) for a yaw about +y), local +z to the right.
      hs.push(heightAt(x + lx * c + lz * s, z - lx * s + lz * c));
    }
  }
  return { min: Math.min(...hs), max: Math.max(...hs) };
}

// Rocks and tree trunks near a point, from the loaded terrain chunks. Rocks under 60 cm (the
// dry river's loose ones) are driven over, so they are no obstacle.
function obstaclesNear(world, x, z, radius) {
  const out = [];
  world.query(RockField).forEach((e) => {
    const field = e.get(RockField);
    for (const r of field.rocks) if (r.size >= 0.6 && Math.hypot(r.x - x, r.z - z) < radius) out.push({ x: r.x, z: r.z, r: r.size * 1.2 });
    for (const p of field.plants ?? []) {
      if (p.kind === 'tree' && Math.hypot(p.x - x, p.z - z) < radius) out.push({ x: p.x, z: p.z, r: 0.5 });
    }
  });
  return out;
}

// How far the whole footprint must stand above the water (town's river and ponds), m.
const WATER_CLEARANCE = 0.3;

// A good place to put the car back on its wheels near (x, z): on the nearest road if the terrain
// has roads, otherwise the nearest level patch, clear of rocks and trees and out of the water. The
// car faces along the road (whichever way is closer to its old heading). Falls back to the old spot.
export function findSpawnSpot(world, heightAt, x0, z0, yaw0) {
  // The dry river's rock bed is never level: allow its humps.
  const tolerance = heightAt.rockAt ? 0.8 : 0.35;
  // (Sunny town's jump streets run down to the water's edge on the far bank.)
  const dryAbove = heightAt.waterLevel !== undefined ? heightAt.waterLevel + WATER_CLEARANCE : -Infinity;
  const level = (x, z, yaw) => {
    const f = footprint(heightAt, x, z, yaw);
    return f.max - f.min < tolerance && f.min > dryAbove;
  };
  const clear = (x, z) => obstaclesNear(world, x, z, 6).every((o) => Math.hypot(o.x - x, o.z - z) > o.r + HALF_LENGTH + 0.3);
  const facing = (h) => {
    // A one-way circuit (the stadium): always the way round.
    if (heightAt.oneWay) return h;
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

// Puts a car (the player's unless `car` is given) on its wheels at (x, z), facing `yaw` (radians
// about +y; 0 faces +x). Tests can start it `lift` m higher and moving forward at `speed` m/s.
export function respawnCarAt(world, heightAt, x, z, yaw = 0, { speed = 0, lift = 0, car = world.queryFirst(IsPlayer, Vehicle) } = {}) {
  if (!car) return null;
  const vehicle = car.get(Vehicle);
  // Drop from just above the highest ground under the car, so no wheel starts inside a slope.
  const ground = footprint(heightAt, x, z, yaw).max;
  const pose = {
    position: { x, y: ground + startHeight(vehicle.tires) + lift, z },
    rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
    linvel: speed ? { x: Math.cos(yaw) * speed, y: 0, z: -Math.sin(yaw) * speed } : ZERO,
    angvel: ZERO,
  };
  const { spec } = car.get(View).object.userData;
  // The player's car takes the tyre model the settings now ask for.
  const tires = spec.player ? playerTires() : vehicle.tires;
  // The same car again: keep its meshes and replace only the physics. New meshes and materials
  // cost a long first frame (about 50-160 ms on an M4) while the renderer sets them up.
  if (car.get(View).object.userData.kind === viewsKind(world.get(Physics).remote, tires)) return replaceCarPhysics(world, car, pose);
  const { input, driver, slot } = vehicle;
  despawnCar(world, car);
  return spawnCar(world, { ...pose, tires, player: spec.player, livery: spec.livery, input, driver, slot });
}

// Gives the car new physics at `pose` (a fresh start: new drivetrain, no steering), keeping its
// entity and meshes.
function replaceCarPhysics(world, car, pose) {
  const { remote } = world.get(Physics);
  const vehicle = car.get(Vehicle);
  const { player } = car.get(View).object.userData.spec;
  let body;
  let controller;
  let drivetrain;
  let id = vehicle.id;
  removeCarPhysics(world, vehicle);
  if (remote) {
    ({ id, body, controller, drivetrain } = remote.spawn(pose, { tires: vehicle.tires, player }));
  } else {
    ({ body, controller } = createCarPhysics(world, pose, vehicle.tires));
    drivetrain = new Drivetrain(DRIVETRAIN);
  }
  Object.assign(vehicle, { body, controller, drivetrain, steer: 0, speed: 0, braking: false, id, held: false });
  if (remote) remote.attach(id, vehicle);
  car.get(RigidBody).body = body;
  const transform = car.get(Transform);
  Object.assign(transform.position, pose.position);
  Object.assign(transform.quaternion, pose.rotation);
  world.query(WheelOf(car), SoftTireView).forEach((wheel) => {
    const view = wheel.get(SoftTireView);
    const { index } = wheel.get(WheelOf(car));
    if (view.gpu) view.gpu = controller.gpu.solver;
    else if (view.soft) view.soft = controller.wheels[index].soft;
  });
  return car;
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
export function requestRespawnAt(world, heightAt, x, z, yaw, options) {
  pendingAction = { type: 'respawnAt', world, heightAt, x, z, yaw, options };
}

// Takes a car out at the start of the next frame (a step may be using it now). Spawning needs no
// wait: a new car joins the next batch of steps.
const pendingCars = [];
export function requestDespawn(world, car) {
  pendingCars.push({ type: 'despawn', world, car });
}

// Puts a car (an AI's) back on its wheels at (x, z) facing `yaw`, at the start of the next frame.
// Queued apart from the player's respawns, so neither replaces the other.
export function requestCarRespawn(world, heightAt, car, x, z, yaw) {
  pendingCars.push({ type: 'respawn', world, car, heightAt, x, z, yaw });
}

export function applyPendingCarAction() {
  for (const a of pendingCars.splice(0)) {
    if (!a.car.isAlive()) continue;
    if (a.type === 'despawn') despawnCar(a.world, a.car);
    else respawnCarAt(a.world, a.heightAt, a.x, a.z, a.yaw, { car: a.car });
  }
  const action = pendingAction;
  pendingAction = null;
  if (action?.type === 'rebuild') rebuildCars(action.world);
  if (action?.type === 'respawn') respawnCar(action.world, action.heightAt);
  if (action?.type === 'respawnAt') respawnCarAt(action.world, action.heightAt, action.x, action.z, action.yaw, action.options);
}
