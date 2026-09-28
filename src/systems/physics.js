import { Deformation, HeightField, Input, Physics, RigidBody, RockField, Time, Transform, Vehicle } from '../ecs/traits.js';
import { ROCK_REFRESH, updateGpuGround, updateGpuRocks } from '../tire/gpu-tires.js';
import { GPU_TIRE } from '../tire/config.js';
import { MAX_STEPS } from '../tire/gpu-tire-solver.js';
import { applyDriverInput } from '../vehicle/physics.js';
import { createPoseHistory, pushPose } from './interpolation.js';
import { count, sample } from '../perf.js';
// ?slowgpu=ms adds that much extra wait per step, to mimic a slower GPU (for profiling).
const SLOW_GPU = Number(new URLSearchParams(location.search).get('slowgpu') ?? 0);

// Keeps the GPU tyre solver's ground grid and nearby rocks centred on the car.
function updateGpuTyreWorld(world, vehicle) {
  const { solver } = vehicle.controller.gpu;
  const p = vehicle.body.translation();
  const { heightAt } = world.get(HeightField);
  updateGpuGround(solver, heightAt, p.x, p.z, world.get(Deformation)?.map);
  // Refresh the rock set when the car has moved a little.
  const last = solver.rockCentre;
  if (!last || Math.hypot(last.x - p.x, last.z - p.z) > ROCK_REFRESH) {
    const rocks = [];
    world.query(RockField).forEach((e) => rocks.push(...e.get(RockField).rocks));
    updateGpuRocks(solver, rocks, p.x, p.z);
    solver.rockCentre = { x: p.x, z: p.z };
  }
}

const MAX_BATCH_STEPS = 4;

// Fixed-step simulation so the car behaves the same at any frame rate. With GPU tyres each
// step waits for the GPU's hub forces, so this is async.
export async function stepPhysics(world, frameDelta = null) {
  const physics = world.get(Physics);
  // The time to simulate: what passed since the last batch (it may span several frames).
  const delta = frameDelta ?? world.get(Time).delta;
  const input = world.get(Input);
  // At most MAX_BATCH_STEPS per batch; time beyond that is dropped. When steps are slow (GPU tyres
  // wait for the GPU, Rapier soft tyres cost ~10 ms), an uncapped batch spirals: a long batch
  // leaves more time to catch up, so the next is longer still, up to 12 steps (~170 ms) between
  // visible updates. Capped, the game slows down evenly instead and still updates every few frames.
  const wanted = physics.accumulator + delta;
  physics.accumulator = Math.min(wanted, physics.step * MAX_BATCH_STEPS);

  const vehicles = [];
  world.query(Vehicle).updateEach(([vehicle]) => vehicles.push(vehicle));
  count('droppedSeconds', wanted - physics.accumulator);
  const tw = performance.now();
  for (const v of vehicles) if (v.controller.gpu) updateGpuTyreWorld(world, v);
  sample('phys.groundUpload', performance.now() - tw);

  const t0 = performance.now();
  let tJs = 0, tGpu = 0, tRapier = 0;
  let steps = 0;
  // GPU tyres can run several steps per GPU round trip (GPU_TIRE.stepsPerTrip): one dispatch
  // computes the tyre forces for the whole trip, then Rapier steps through them one by one.
  const tripSize = vehicles.some((v) => v.controller.gpu && !v.controller.gpu.pipelined)
    ? Math.max(1, Math.min(MAX_STEPS, Math.round(GPU_TIRE.stepsPerTrip ?? 1)))
    : 1;
  while (physics.accumulator >= physics.step) {
    const n = Math.max(1, Math.min(tripSize, Math.floor((physics.accumulator + 1e-9) / physics.step)));
    // Read tyre positions back once per batch, on its last trip, for drawing.
    const lastTrip = physics.accumulator - n * physics.step < physics.step;
    const logs = new Map();
    for (let j = 0; j < n; j++) {
      for (const vehicle of vehicles) {
        let ta = performance.now();
        applyDriverInput(vehicle, input, physics.step);
        vehicle.controller.updateVehicle(physics.step);
        let tb = performance.now();
        tJs += tb - ta;
        if (vehicle.controller.gpu) {
          if (j === 0) {
            // The trip's drive and brake torques come from this first step's inputs.
            if (tripSize > 1) logs.set(vehicle, await vehicle.controller.stepTyresBatch(n, physics.step, { readPositions: lastTrip }));
            else await vehicle.controller.stepTyres({ readPositions: lastTrip });
            if (physics.slowGpu ?? SLOW_GPU) await new Promise((r) => setTimeout(r, physics.slowGpu ?? SLOW_GPU));
          }
          const log = logs.get(vehicle);
          if (log) vehicle.controller.applyTyreForces(log, j);
        }
        ta = performance.now();
        tGpu += ta - tb;
        vehicle.speed = vehicle.controller.currentVehicleSpeed();
      }
      const tr = performance.now();
      physics.world.step();
      tRapier += performance.now() - tr;
      physics.accumulator -= physics.step;
      physics.simTime += physics.step;
      steps++;
      recordPoses(world, physics.simTime);
      physics.onStep?.(physics.simTime);
    }
    // Remember where each hub was when the drawn tyre shape was read back: drawing moves the
    // shape with the hub from there, so tyres never lag the car while physics catches up.
    if (lastTrip) {
      for (const vehicle of vehicles) {
        const solver = vehicle.controller.gpu?.solver;
        if (solver) solver.readbackHubs = vehicle.controller.wheels.map((w) => ({ p: { ...w.hub.translation() }, q: { ...w.hub.rotation() } }));
      }
    }
  }
  const batchMs = performance.now() - t0;
  physics.lastBatch = { steps, ms: batchMs, js: tJs, gpu: tGpu, rapier: tRapier, dropped: wanted - Math.min(wanted, physics.step * MAX_BATCH_STEPS) };
  count('steps', steps);
  count('simSeconds', steps * physics.step);
  sample('batch.steps', steps);
  sample('batch.ms', batchMs);
  if (steps) {
    sample('step.total', batchMs / steps);
    sample('step.vehicleJs', tJs / steps);
    sample('step.gpuWait', tGpu / steps);
    sample('step.rapier', tRapier / steps);
  }
  if (steps) physics.stepMs = physics.stepMs * 0.95 + ((performance.now() - t0) / steps) * 0.05;
}

// Pose history per Rapier body, for drawing between physics steps (see interpolation.js).
export const histories = new WeakMap();
function recordPoses(world, t) {
  world.query(RigidBody).forEach((entity) => {
    const { body } = entity.get(RigidBody);
    let history = histories.get(body);
    if (!history) histories.set(body, (history = createPoseHistory()));
    pushPose(history, t, body.translation(), body.rotation());
  });
}
