// Physics worker: Rapier, the cars, their drivetrains, and the GPU tyre solvers run here, on their own
// thread and their own GPU device. The main thread draws. Here nothing waits behind the frame's
// render work in a shared GPU queue, or behind the frame's JavaScript. See physics/client.js for
// the other side and the message protocol.
import RAPIER from '@dimforge/rapier3d-compat';
import { createWorld } from 'koota';
import { CONTROLS } from '../controls.js';
import { Deformation, HeightField, Input, IsPlayer, Physics, RigidBody, RockField, Vehicle } from '../ecs/traits.js';
import { stepPhysics } from '../systems/physics.js';
import { GroundDeformation } from '../terrain/deformation.js';
import { createHeightField } from '../terrain/height.js';
import { GPU_TIRE, GROUND, TIRE, effectiveGpuTire, effectiveTire, setPavedRoads, setSnowCover } from '../tire/config.js';
import { createGpuTires } from '../tire/gpu-tires.js';
import { CAR, DRIVETRAIN } from '../vehicle/config.js';
import { Drivetrain } from '../vehicle/drivetrain.js';
import { WHEELS, applyWheelSettings, createCarBody } from '../vehicle/physics.js';
import { createSoftCarBody } from '../vehicle/soft-vehicle.js';
import { createColliderStreamer } from './colliders.js';
import { createPropPhysics } from './props.js';
import { AudioFeed } from '../audio/feed.js';

const STEP = 1 / 120;
const SETTINGS = { CAR, TIRE, GPU_TIRE, GROUND, DRIVETRAIN, CONTROLS };

let world = null; // koota world with the physics traits
let physics = null; // the Physics trait (Rapier world, clock)
let device = null;
let colliders = null;
let props = null; // the sunny town's loose props
let deformation = null;
// The cars, by the id the main thread gave each: { entity, poses } (poses: the chassis pose of
// every step since the last state message).
const cars = new Map();
// Drivetrains of cars just taken out, by id, for a rebuilt car to carry on with (see spawn).
const retired = new Map();
let pending = []; // spawn and settings actions, applied between batches
let busy = false;
let simLast = 0;

// Copies settings from the main thread (it owns saving and the tuning panel).
function applySettings(all) {
  for (const [name, values] of Object.entries(all)) {
    const target = SETTINGS[name];
    for (const [key, value] of Object.entries(values)) {
      if (value && typeof value === 'object' && !Array.isArray(value) && target[key]) Object.assign(target[key], value);
      else target[key] = value;
    }
  }
}

function despawn(id) {
  const car = cars.get(id);
  if (!car) return;
  const { controller, body, drivetrain } = car.entity.get(Vehicle);
  // The jointed car owns its hubs, joints, and GPU tyres; the raycast car is one controller.
  if (controller.dispose) controller.dispose();
  else physics.world.removeVehicleController(controller);
  physics.world.removeRigidBody(body);
  car.entity.destroy();
  cars.delete(id);
  retired.set(id, drivetrain);
}

// A car at a pose: `tires` 'gpu' (soft tyres on this thread's GPU tyre solver) or 'rigid'
// (Rapier's raycast vehicle). `keepDrivetrain`: the id of a car just taken out whose gearbox and
// engine state it carries on with (a rebuild).
function spawn({ id, position, rotation, linvel, angvel, steer = 0, keepDrivetrain = 0, tires = 'gpu', player = true }) {
  despawn(id);
  let body;
  let controller;
  if (tires === 'rigid') {
    ({ body, controller } = createCarBody(RAPIER, physics.world, position));
    body.setRotation(rotation, true);
    body.setLinvel(linvel, true);
    body.setAngvel(angvel, true);
  } else {
    const gpu = effectiveGpuTire(GPU_TIRE, CONTROLS.performance);
    const gpuTires = createGpuTires(device, WHEELS.length, TIRE, gpu);
    gpuTires.solver.setParams(gpu, STEP);
    gpuTires.pipelined = gpu.pipelined;
    const tire = effectiveTire(TIRE, CONTROLS.performance);
    ({ body, controller } = createSoftCarBody(RAPIER, physics.world, position, CAR, tire, { gpuTires, rotation, linvel, angvel }));
  }
  const old = keepDrivetrain ? retired.get(keepDrivetrain) : null;
  retired.clear();
  const drivetrain = old ?? new Drivetrain(DRIVETRAIN);
  const entity = world.spawn(RigidBody({ body }), Vehicle({ controller, body, drivetrain, steer, speed: 0, tires, id }));
  if (player) entity.add(IsPlayer);
  cars.set(id, { entity, poses: [] });
  colliders.update(centres(), { force: true });
  if (player) props?.update(position.x, position.z);
}

// Where every car is, for the terrain colliders.
const centres = () => [...cars.values()].map(({ entity }) => entity.get(Vehicle).body.translation());

function playerCar() {
  for (const car of cars.values()) if (car.entity.has(IsPlayer)) return car;
  return null;
}

function applyPending() {
  const actions = pending;
  pending = [];
  for (const a of actions) {
    if (a.type === 'spawn') spawn(a);
    else if (a.type === 'despawn') despawn(a.id);
    else if (a.type === 'settings') {
      applySettings(a.settings);
      for (const { entity } of cars.values()) {
        const { controller } = entity.get(Vehicle);
        controller.gpu?.solver.setParams(effectiveGpuTire(GPU_TIRE, CONTROLS.performance), STEP);
        applyWheelSettings(controller);
        controller.dirty = true; // spring settings are re-applied on the next step
      }
    } else if (a.type === 'shift') {
      const d = cars.get(a.id)?.entity.get(Vehicle).drivetrain;
      if (a.dir > 0) d?.shiftUp();
      else d?.shiftDown();
    } else if (a.type === 'clearDeformation') deformation.clear();
  }
}

const pose = (b) => ({ p: { ...b.translation() }, q: { ...b.rotation() }, v: { ...b.linvel() }, w: { ...b.angvel() } });

// The wheels as the draw side needs them: the jointed car's hubs and links, or the raycast car's
// suspension lengths and contact points.
function wheelStates(c) {
  if (!c.wheels) {
    return [0, 1, 2, 3].map((i) => ({
      suspension: c.wheelSuspensionLength(i),
      rotation: c.wheelRotation(i),
      steering: c.wheelSteering(i),
      contact: c.wheelIsInContact(i),
      contactPoint: c.wheelIsInContact(i) ? { ...c.wheelContactPoint(i) } : null,
    }));
  }
  return c.wheels.map((w, i) => ({
    hub: pose(w.hub),
    hubPose: c.wheelHubPose(i),
    suspension: c.suspensionPose(i),
    spin: c.wheelSpin(i),
    rotation: c.wheelRotation(i),
    steering: c.wheelSteering(i),
    contact: c.wheelIsInContact(i),
    detached: c.wheelDetached(i),
    seat: c.wheelDetached(i) ? c.wheelSeat(i) : null,
  }));
}

// One car's state for the draw side; its buffers go into `transfer`.
function carState(id, car, readback, transfer) {
  const vehicle = car.entity.get(Vehicle);
  const c = vehicle.controller;
  const solver = c.gpu?.solver;
  const d = vehicle.drivetrain;
  const steps = new Float32Array(car.poses.length * 8);
  car.poses.forEach((s, i) => steps.set(s, i * 8));
  car.poses = [];
  const positions = readback && solver ? solver.positions.slice() : null;
  transfer.push(steps.buffer);
  if (positions) transfer.push(positions.buffer);
  return {
    id,
    steps,
    body: pose(vehicle.body),
    wheels: wheelStates(c),
    speed: vehicle.speed,
    steer: vehicle.steer,
    braking: vehicle.braking,
    drivetrain: { rpm: d.rpm, gear: d.gear, pendingGear: d.pendingGear, throttle: d.throttle, fuel: d.fuel, exhaustBrake: d.exhaustBrake, clutch: d.clutch, shaftTorque: d.shaftTorque, engaged: { ...d.engaged } },
    positions,
    readbackHubs: solver?.readbackHubs ?? null,
  };
}

function snapshot(readback) {
  const transfer = [];
  const message = {
    type: 'state',
    simTime: physics.simTime,
    stepMs: physics.stepMs,
    batch: physics.lastBatch,
    cars: [...cars].map(([id, car]) => carState(id, car, readback, transfer)),
    // The props that moved (physics/props.js), for drawing.
    props: props ? props.moved() : null,
  };
  if (message.props) transfer.push(message.props.buffer);
  postMessage(message, transfer);
}

// A zero-delay yield that is not clamped like nested timers are.
const channel = new MessageChannel();
channel.port1.onmessage = () => simulate();

async function simulate() {
  if (busy || !cars.size) return;
  busy = true;
  try {
    const now = performance.now();
    const delta = Math.min((now - simLast) / 1000, 0.1);
    simLast = now;
    applyPending();
    colliders.update(centres());
    const player = playerCar();
    if (player) {
      const p = player.entity.get(Vehicle).body.translation();
      props?.update(p.x, p.z);
    }
    const before = physics.simTime;
    await stepPhysics(world, delta);
    if (physics.simTime > before) snapshot(true);
  } catch (error) {
    postMessage({ type: 'error', message: String(error?.stack ?? error) });
  } finally {
    busy = false;
    // Behind (the batch took longer than a step): go straight on, as on the main thread.
    if (performance.now() - simLast >= STEP * 1000) channel.port2.postMessage(0);
  }
}

async function init(msg) {
  await RAPIER.init();
  if (!self.navigator.gpu) throw new Error('WebGPU is not available in workers');
  const adapter = await navigator.gpu.requestAdapter();
  device = await adapter.requestDevice();
  applySettings(msg.settings);

  const physicsWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  physicsWorld.timestep = STEP;
  physicsWorld.numSolverIterations = 8;
  world = createWorld();
  const heightAt = createHeightField({ mode: msg.terrain });
  setSnowCover(heightAt.snow);
  setPavedRoads(heightAt.paved);
  deformation = new GroundDeformation();
  for (const [key, tile] of msg.tiles ?? []) deformation.adoptTile(key, tile);
  world.add(Input, Physics({ rapier: RAPIER, world: physicsWorld, accumulator: 0, step: STEP, stepMs: 0, simTime: 0, displayTime: 0 }));
  world.add(HeightField({ heightAt, surfaceAt: (x, z) => heightAt(x, z) + deformation.at(x, z) }));
  world.add(Deformation({ map: deformation }));
  physics = world.get(Physics);
  physics.slowGpu = msg.slowGpu ?? 0;
  // Shared with the main thread's audio worklet: this thread writes the engine state every step.
  physics.audioFeed = msg.audioFeed ? new AudioFeed(msg.audioFeed) : null;
  physics.onStep = () => {
    for (const car of cars.values()) {
      const b = car.entity.get(Vehicle).body;
      const t = b.translation();
      const q = b.rotation();
      car.poses.push([physics.simTime, t.x, t.y, t.z, q.x, q.y, q.z, q.w]);
    }
  };
  colliders = createColliderStreamer({ rapier: RAPIER, world: physicsWorld, ecs: world, RockField, heightAt, rockCount: msg.rocks });
  if (heightAt.town) props = createPropPhysics(RAPIER, physicsWorld, heightAt);
  simLast = performance.now();
  postMessage({ type: 'ready' });
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') await init(msg);
    else if (msg.type === 'tick') {
      Object.assign(world.get(Input), msg.input);
      // The other cars' drivers (an AI's pedals and steering), by car id; a car left out holds still.
      for (const car of cars.values()) car.entity.get(Vehicle).input = null;
      for (const [id, input] of msg.inputs ?? []) {
        const car = cars.get(id);
        if (car) car.entity.get(Vehicle).input = input;
      }
      deformation.markChanged(msg.deformVersion, null);
      simulate();
    } else if (msg.type === 'tile') deformation.adoptTile(msg.key, msg.tile);
    else if (msg.type === 'probe') {
      // Debugging: the rut depth the worker sees at (x, z).
      postMessage({ type: 'probe', id: msg.id, rut: deformation.at(msg.x, msg.z), tiles: deformation.tiles.size, version: deformation.version });
    }
    else {
      pending.push(msg);
      // A spawn with no car yet (the first one) cannot wait for a batch.
      if (!cars.size && msg.type === 'spawn' && !busy) applyPending();
    }
  } catch (error) {
    postMessage({ type: 'error', message: String(error?.stack ?? error) });
  }
};
