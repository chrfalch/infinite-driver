// Physics worker: Rapier, the car, its drivetrain, and the GPU tyre solver run here, on their own
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
import { GPU_TIRE, GROUND, TIRE, effectiveGpuTire, effectiveTire } from '../tire/config.js';
import { createGpuTires } from '../tire/gpu-tires.js';
import { CAR, DRIVETRAIN } from '../vehicle/config.js';
import { Drivetrain } from '../vehicle/drivetrain.js';
import { WHEELS, applyWheelSettings } from '../vehicle/physics.js';
import { createSoftCarBody } from '../vehicle/soft-vehicle.js';
import { createColliderStreamer } from './colliders.js';
import { AudioFeed } from '../audio/feed.js';

const STEP = 1 / 120;
const SETTINGS = { CAR, TIRE, GPU_TIRE, GROUND, DRIVETRAIN, CONTROLS };

let world = null; // koota world with the physics traits
let physics = null; // the Physics trait (Rapier world, clock)
let device = null;
let colliders = null;
let deformation = null;
let car = null; // player entity
let carId = 0;
let pending = []; // spawn and settings actions, applied between batches
let busy = false;
let simLast = 0;
let stepPoses = [];

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

function despawn() {
  if (!car) return;
  const { controller, body } = car.get(Vehicle);
  controller.dispose();
  physics.world.removeRigidBody(body);
  car.destroy();
  car = null;
}

function spawn({ id, position, rotation, linvel, angvel, steer = 0, keepDrivetrain = false }) {
  const old = car?.get(Vehicle).drivetrain;
  despawn();
  const gpu = effectiveGpuTire(GPU_TIRE, CONTROLS.performance);
  const gpuTires = createGpuTires(device, WHEELS.length, TIRE, gpu);
  gpuTires.solver.setParams(gpu, STEP);
  gpuTires.pipelined = gpu.pipelined;
  const tire = effectiveTire(TIRE, CONTROLS.performance);
  const { body, controller } = createSoftCarBody(RAPIER, physics.world, position, CAR, tire, { gpuTires, rotation, linvel, angvel });
  const drivetrain = keepDrivetrain && old ? old : new Drivetrain(DRIVETRAIN);
  car = world.spawn(IsPlayer, RigidBody({ body }), Vehicle({ controller, body, drivetrain, steer, speed: 0 }));
  carId = id;
  colliders.update(position.x, position.z, { force: true });
}

function applyPending() {
  const actions = pending;
  pending = [];
  for (const a of actions) {
    if (a.type === 'spawn') spawn(a);
    else if (a.type === 'settings') {
      applySettings(a.settings);
      const controller = car?.get(Vehicle).controller;
      if (controller) {
        controller.gpu?.solver.setParams(effectiveGpuTire(GPU_TIRE, CONTROLS.performance), STEP);
        applyWheelSettings(controller);
        controller.dirty = true; // spring settings are re-applied on the next step
      }
    } else if (a.type === 'shift') {
      const d = car?.get(Vehicle).drivetrain;
      if (a.dir > 0) d?.shiftUp();
      else d?.shiftDown();
    } else if (a.type === 'clearDeformation') deformation.clear();
  }
}

const pose = (b) => ({ p: { ...b.translation() }, q: { ...b.rotation() }, v: { ...b.linvel() }, w: { ...b.angvel() } });

function snapshot(readback) {
  const vehicle = car.get(Vehicle);
  const c = vehicle.controller;
  const solver = c.gpu?.solver;
  const d = vehicle.drivetrain;
  const steps = new Float32Array(stepPoses.length * 8);
  stepPoses.forEach((s, i) => steps.set(s, i * 8));
  stepPoses = [];
  const positions = readback && solver ? solver.positions.slice() : null;
  const message = {
    type: 'state',
    carId,
    simTime: physics.simTime,
    stepMs: physics.stepMs,
    batch: physics.lastBatch,
    steps,
    body: pose(vehicle.body),
    wheels: c.wheels.map((w, i) => ({
      hub: pose(w.hub),
      hubPose: c.wheelHubPose(i),
      suspension: c.suspensionPose(i),
      spin: c.wheelSpin(i),
      rotation: c.wheelRotation(i),
      steering: c.wheelSteering(i),
      contact: c.wheelIsInContact(i),
    })),
    speed: vehicle.speed,
    steer: vehicle.steer,
    braking: vehicle.braking,
    drivetrain: { rpm: d.rpm, gear: d.gear, pendingGear: d.pendingGear, throttle: d.throttle, fuel: d.fuel, exhaustBrake: d.exhaustBrake, clutch: d.clutch },
    positions,
    readbackHubs: solver?.readbackHubs ?? null,
  };
  postMessage(message, positions ? [positions.buffer, steps.buffer] : [steps.buffer]);
}

// A zero-delay yield that is not clamped like nested timers are.
const channel = new MessageChannel();
channel.port1.onmessage = () => simulate();

async function simulate() {
  if (busy || !car) return;
  busy = true;
  try {
    const now = performance.now();
    const delta = Math.min((now - simLast) / 1000, 0.1);
    simLast = now;
    applyPending();
    const p = car.get(Vehicle).body.translation();
    colliders.update(p.x, p.z);
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
    const b = car.get(Vehicle).body;
    const t = b.translation();
    const q = b.rotation();
    stepPoses.push([physics.simTime, t.x, t.y, t.z, q.x, q.y, q.z, q.w]);
  };
  colliders = createColliderStreamer({ rapier: RAPIER, world: physicsWorld, ecs: world, RockField, heightAt, rockCount: msg.rocks });
  simLast = performance.now();
  postMessage({ type: 'ready' });
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') await init(msg);
    else if (msg.type === 'tick') {
      Object.assign(world.get(Input), msg.input);
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
      if (!car && msg.type === 'spawn' && !busy) applyPending();
    }
  } catch (error) {
    postMessage({ type: 'error', message: String(error?.stack ?? error) });
  }
};
