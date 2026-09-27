// Main-thread side of the physics worker (see physics/worker.js).
//
// main → worker: 'init' (terrain, settings, shared rut tiles), 'tick' (input, every frame),
//   'spawn' (a car at a pose; also rebuilds and respawns), 'settings' (after any save), 'shift',
//   'tile' (a new shared rut tile), 'clearDeformation'.
// worker → main: 'ready', 'state' (after each batch: the chassis pose of every step, the newest
//   poses of chassis and hubs, suspension, drivetrain, tyre particles), 'error'.
//
// The draw code reads the car through RemoteBody and RemoteController, which offer the same fields
// and methods as the local bodies and controller (body.translation(), wheelHubPose(i), gpu.solver.positions, …), filled
// from the newest 'state'.
import { CONTROLS } from '../controls.js';
import { onSettingsSaved } from '../settings-store.js';
import { count, sample } from '../perf.js';
import { createPoseHistory, pushPose } from '../systems/interpolation.js';
import { histories } from '../systems/physics.js';
import { GPU_TIRE, GROUND, TIRE, effectiveTire } from '../tire/config.js';
import { CAR, DRIVETRAIN } from '../vehicle/config.js';
import { WHEELS, wheelMount } from '../vehicle/physics.js';

const settingsBundle = () => JSON.parse(JSON.stringify({ CAR, TIRE, GPU_TIRE, GROUND, DRIVETRAIN, CONTROLS }));

// A body whose state comes from the worker.
class RemoteBody {
  constructor(p, q, v = { x: 0, y: 0, z: 0 }, w = { x: 0, y: 0, z: 0 }) {
    this.s = { p: { ...p }, q: { ...q }, v: { ...v }, w: { ...w } };
  }
  set(s) {
    this.s = s;
  }
  translation() {
    return this.s.p;
  }
  rotation() {
    return this.s.q;
  }
  linvel() {
    return this.s.v;
  }
  angvel() {
    return this.s.w;
  }
}

const noop = () => {};

// Stands in for the soft car's controller on the main thread (read-only; the worker drives).
class RemoteController {
  constructor(pose) {
    this.tire = effectiveTire(TIRE, CONTROLS.performance);
    this.wheels = WHEELS.map((_, i) => ({ hub: new RemoteBody(pose.position, pose.rotation), mount: wheelMount(i) }));
    this.state = null;
    // What the draw code reads from the GPU solver; positions arrive with each batch.
    const perTire = 0; // set by the first state
    this.gpu = {
      pipelined: false,
      solver: { positions: new Float32Array(0), perTire, readbackHubs: null, rockList: [], ready: false, setParams: noop },
    };
    for (const name of [
      'setWheelSteering', 'setWheelEngineForce', 'setWheelBrake', 'setWheelFrictionSlip', 'setWheelSuspensionRestLength',
      'setWheelMaxSuspensionTravel', 'setWheelSuspensionStiffness', 'setWheelSuspensionCompression',
      'setWheelSuspensionRelaxation', 'setWheelMaxSuspensionForce', 'setWheelSideFrictionStiffness', 'dispose',
    ]) this[name] = noop;
  }
  wheel(i) {
    return this.state?.wheels[i];
  }
  numWheels() {
    return WHEELS.length;
  }
  currentVehicleSpeed() {
    return this.state?.speed ?? 0;
  }
  wheelHubPose(i) {
    return this.wheel(i)?.hubPose ?? { position: wheelMount(i), steer: { x: 0, y: 0, z: 0, w: 1 }, spin: { x: 0, y: 0, z: 0, w: 1 } };
  }
  suspensionPose(i) {
    return this.wheel(i)?.suspension ?? null;
  }
  wheelSpin(i) {
    return this.wheel(i)?.spin ?? 0;
  }
  wheelRotation(i) {
    return this.wheel(i)?.rotation ?? 0;
  }
  wheelSteering(i) {
    return this.wheel(i)?.steering ?? 0;
  }
  wheelIsInContact(i) {
    return this.wheel(i)?.contact ?? false;
  }
  rollingRadius() {
    return this.tire.outerRadius * 0.925;
  }
}

export function createPhysicsClient({ terrain, rocks, deformation, slowGpu = 0 }) {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  let ready = null;
  let failed = null;
  let nextId = 1;
  let current = null; // { id, vehicle } of the car the worker simulates
  const client = { simTime: 0, stepMs: 0, error: null };

  // Shared rut tiles: announce new ones; a clear on either side clears both.
  deformation.onTile = (key, tile) => worker.postMessage({ type: 'tile', key, tile });
  deformation.onClear = () => worker.postMessage({ type: 'clearDeformation' });
  const unsubscribe = onSettingsSaved(() => worker.postMessage({ type: 'settings', settings: settingsBundle() }));

  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'ready') ready?.();
    else if (msg.type === 'error') {
      client.error = msg.message;
      console.error('[physics worker]', msg.message);
      failed?.(new Error(msg.message));
    } else if (msg.type === 'state') receive(msg);
    else if (msg.type === 'probe') probes.get(msg.id)?.(msg);
  };
  worker.onerror = (e) => {
    client.error = e.message;
    console.error('[physics worker]', e.message);
    failed?.(new Error(e.message || 'physics worker failed to load'));
  };

  function receive(msg) {
    client.simTime = msg.simTime;
    client.stepMs = msg.stepMs;
    if (msg.batch?.steps) {
      const b = msg.batch;
      sample('batch.steps', b.steps);
      sample('batch.ms', b.ms);
      sample('step.total', b.ms / b.steps);
      sample('step.gpuWait', b.gpu / b.steps);
      sample('step.rapier', b.rapier / b.steps);
      count('steps', b.steps);
      count('simSeconds', b.steps / 120);
    }
    count('droppedSeconds', msg.batch?.dropped ?? 0);
    if (!current || msg.carId !== current.id) return; // a car that was replaced since
    const v = current.vehicle;
    const c = v.controller;
    c.state = msg;
    v.body.set(msg.body);
    msg.wheels.forEach((w, i) => c.wheels[i].hub.set(w.hub));
    v.speed = msg.speed;
    v.steer = msg.steer;
    v.braking = msg.braking;
    Object.assign(v.drivetrain, msg.drivetrain);
    const history = histories.get(v.body) ?? histories.set(v.body, createPoseHistory()).get(v.body);
    const s = msg.steps;
    for (let k = 0; k < s.length; k += 8) {
      pushPose(history, s[k], { x: s[k + 1], y: s[k + 2], z: s[k + 3] }, { x: s[k + 4], y: s[k + 5], z: s[k + 6], w: s[k + 7] });
    }
    if (msg.positions) {
      const solver = c.gpu.solver;
      solver.positions = msg.positions;
      solver.perTire = msg.positions.length / 4 / WHEELS.length;
      solver.readbackHubs = msg.readbackHubs;
      solver.ready = true;
    }
  }

  // A car for the draw code, simulated by the worker from `pose` on. With `keepDrivetrain`
  // (rebuilds) the worker keeps the old car's gearbox and engine state.
  client.spawn = (pose, { keepDrivetrain = false } = {}) => {
    const id = nextId++;
    const body = new RemoteBody(pose.position, pose.rotation, pose.linvel, pose.angvel);
    const controller = new RemoteController(pose);
    const drivetrain = {
      rpm: 0,
      gear: 0,
      pendingGear: null,
      params: DRIVETRAIN,
      shiftUp: () => worker.postMessage({ type: 'shift', dir: 1 }),
      shiftDown: () => worker.postMessage({ type: 'shift', dir: -1 }),
    };
    const vehicle = { body, controller, drivetrain };
    current = { id, vehicle };
    pendingSpawnId = id;
    worker.postMessage({ type: 'spawn', id, keepDrivetrain, ...JSON.parse(JSON.stringify(pose)) });
    return vehicle;
  };

  // The entity's Vehicle object for the car just spawned (speed, steer, braking are written there).
  let pendingSpawnId = 0;
  client.attach = (vehicle) => {
    if (current?.id === pendingSpawnId) current.vehicle = vehicle;
  };

  // Debugging: what the worker sees at (x, z) (see 'probe' in worker.js).
  const probes = new Map();
  client.probe = (x, z) =>
    new Promise((resolve) => {
      const id = nextId++;
      probes.set(id, resolve);
      worker.postMessage({ type: 'probe', id, x, z });
    });

  client.tick = (input) => worker.postMessage({ type: 'tick', input: { ...input }, deformVersion: deformation.version });

  // Resolves when the worker is ready; rejects if it fails to start (the caller then keeps the
  // physics on the main thread).
  client.start = () => {
    const tiles = [...deformation.tiles.entries()];
    worker.postMessage({ type: 'init', terrain, rocks, settings: settingsBundle(), tiles, slowGpu });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('physics worker did not start in 15 s')), 15000);
      ready = () => {
        clearTimeout(timer);
        failed = null;
        resolve();
      };
      failed = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  };

  client.stop = () => {
    worker.terminate();
    deformation.onTile = deformation.onClear = null;
    unsubscribe();
  };

  return client;
}

// Worker physics needs WebGPU inside workers; checked once with a tiny worker.
export function workerGpuSupported() {
  return new Promise((resolve) => {
    const code = 'postMessage(!!(self.navigator && self.navigator.gpu))';
    try {
      const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      const timer = setTimeout(() => resolve(false), 3000);
      w.onmessage = (e) => {
        clearTimeout(timer);
        w.terminate();
        resolve(e.data === true);
      };
      w.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}
