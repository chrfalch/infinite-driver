// Main-thread side of the physics worker (see physics/worker.js).
//
// main → worker: 'init' (terrain, settings, shared rut tiles), 'tick' (the player's input and the
//   other cars' inputs, every frame), 'spawn' (a car with an id at a pose, with its tyre model;
//   also rebuilds and respawns), 'despawn' (a car by id), 'settings' (after any save), 'shift' (a
//   car by id), 'tile' (a new shared rut tile), 'clearDeformation'.
// worker → main: 'ready', 'state' (after each batch, for every car: the chassis pose of every
//   step, the newest poses of chassis and hubs, suspension, drivetrain, tyre particles), 'error'.
//
// The draw code reads each car through RemoteBody and a remote controller (RemoteController for
// the jointed car on GPU tyres, RemoteRaycastController for rigid wheels), which offer the same
// fields and methods as the local bodies and controllers (body.translation(), wheelHubPose(i),
// gpu.solver.positions, …), filled from the newest 'state'.
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
const SETTERS = [
  'setWheelSteering', 'setWheelEngineForce', 'setWheelBrake', 'setWheelFrictionSlip', 'setWheelSuspensionRestLength',
  'setWheelMaxSuspensionTravel', 'setWheelSuspensionStiffness', 'setWheelSuspensionCompression',
  'setWheelSuspensionRelaxation', 'setWheelMaxSuspensionForce', 'setWheelSideFrictionStiffness', 'dispose',
];

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
    for (const name of SETTERS) this[name] = noop;
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
  wheelDetached(i) {
    return this.wheel(i)?.detached ?? false;
  }
  wheelSeat(i) {
    return this.wheel(i)?.seat ?? this.wheelHubPose(i).position;
  }
  rollingRadius() {
    return this.tire.outerRadius * 0.925;
  }
}

// Stands in for Rapier's raycast vehicle (rigid wheels) on the main thread. Like Rapier's, it has
// no `wheels`, `gpu` or `wheelHubPose`: the draw code tells the two kinds of car apart by those.
class RemoteRaycastController {
  constructor() {
    this.state = null;
    for (const name of SETTERS) this[name] = noop;
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
  wheelSuspensionLength(i) {
    return this.wheel(i)?.suspension ?? null;
  }
  wheelSteering(i) {
    return this.wheel(i)?.steering ?? 0;
  }
  wheelRotation(i) {
    return this.wheel(i)?.rotation ?? 0;
  }
  wheelIsInContact(i) {
    return this.wheel(i)?.contact ?? false;
  }
  wheelContactPoint(i) {
    return this.wheel(i)?.contactPoint ?? null;
  }
}

export function createPhysicsClient({ terrain, rocks, deformation, slowGpu = 0, audioFeed = null }) {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  let ready = null;
  let failed = null;
  let nextId = 1;
  // The cars the worker simulates, by id: the Vehicle object each one's state is written to.
  const cars = new Map();
  const client = { simTime: 0, stepMs: 0, error: null, propPoses: [] };

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
    // Moving props' poses, kept in order until the frame draws them (render/props-mesh.js).
    if (msg.props?.length) client.propPoses.push(msg.props);
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
    if (msg.timing) {
      const t = msg.timing;
      count('worker.ticks', t.ticks);
      count('worker.skipped', t.skipped);
      count('worker.lostSeconds', t.lost);
      count('worker.batches', 1);
      sample('worker.gap', t.gap);
      sample('worker.outside', t.outside);
    }
    // (A car that was replaced or taken out since is skipped.)
    for (const state of msg.cars) {
      const v = cars.get(state.id);
      if (v) receiveCar(v, state);
    }
  }

  function receiveCar(v, msg) {
    const c = v.controller;
    c.state = msg;
    v.body.set(msg.body);
    if (c.wheels) msg.wheels.forEach((w, i) => c.wheels[i].hub.set(w.hub));
    v.speed = msg.speed;
    v.steer = msg.steer;
    v.braking = msg.braking;
    Object.assign(v.drivetrain, msg.drivetrain);
    const history = histories.get(v.body) ?? histories.set(v.body, createPoseHistory()).get(v.body);
    const s = msg.steps;
    for (let k = 0; k < s.length; k += 8) {
      pushPose(history, s[k], { x: s[k + 1], y: s[k + 2], z: s[k + 3] }, { x: s[k + 4], y: s[k + 5], z: s[k + 6], w: s[k + 7] });
    }
    if (msg.positions && c.gpu) {
      const solver = c.gpu.solver;
      solver.positions = msg.positions;
      solver.perTire = msg.positions.length / 4 / WHEELS.length;
      solver.readbackHubs = msg.readbackHubs;
      solver.ready = true;
    }
  }

  // A car for the draw code, simulated by the worker from `pose` on, with tyre model `tires`
  // ('gpu' or 'rigid'; the worker has no Rapier soft tyres). `keepDrivetrain`: the id of the car
  // it replaces (rebuilds), whose gearbox and engine state the worker carries on with.
  client.spawn = (pose, { keepDrivetrain = 0, tires = 'gpu', player = true } = {}) => {
    const id = nextId++;
    const body = new RemoteBody(pose.position, pose.rotation, pose.linvel, pose.angvel);
    const controller = tires === 'rigid' ? new RemoteRaycastController() : new RemoteController(pose);
    const drivetrain = {
      carId: id,
      rpm: 0,
      gear: 0,
      pendingGear: null,
      params: DRIVETRAIN,
      shiftUp: () => worker.postMessage({ type: 'shift', id, dir: 1 }),
      shiftDown: () => worker.postMessage({ type: 'shift', id, dir: -1 }),
    };
    const vehicle = { body, controller, drivetrain };
    cars.set(id, vehicle);
    worker.postMessage({ type: 'spawn', id, keepDrivetrain, tires: tires === 'rigid' ? 'rigid' : 'gpu', player, ...JSON.parse(JSON.stringify(pose)) });
    return { id, ...vehicle };
  };

  // The entity's Vehicle object for car `id` (its speed, steer, braking are written there).
  client.attach = (id, vehicle) => {
    if (cars.has(id)) cars.set(id, vehicle);
  };

  client.despawn = (id) => {
    if (!cars.delete(id)) return;
    worker.postMessage({ type: 'despawn', id });
  };

  // Debugging: what the worker sees at (x, z) (see 'probe' in worker.js).
  const probes = new Map();
  client.probe = (x, z) =>
    new Promise((resolve) => {
      const id = nextId++;
      probes.set(id, resolve);
      worker.postMessage({ type: 'probe', id, x, z });
    });

  // The player's input, and the other cars' (`inputs`: [id, input] pairs).
  client.tick = (input, inputs = []) => worker.postMessage({ type: 'tick', input: { ...input }, inputs, deformVersion: deformation.version });

  // Resolves when the worker is ready; rejects if it fails to start (the caller then keeps the
  // physics on the main thread).
  client.start = () => {
    const tiles = [...deformation.tiles.entries()];
    // The audio feed only if it is shared memory (a copy would never reach the audio thread).
    const feedBuffer = audioFeed?.shared ? audioFeed.buffer : null;
    worker.postMessage({ type: 'init', terrain, rocks, settings: settingsBundle(), tiles, slowGpu, audioFeed: feedBuffer });
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
