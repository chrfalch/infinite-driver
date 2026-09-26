import { Deformation, HeightField, Input, Physics, RigidBody, RockField, Time, Transform, Vehicle } from '../ecs/traits.js';
import { updateGpuGround, updateGpuRocks } from '../tire/gpu-tires.js';
import { applyDriverInput } from '../vehicle/physics.js';

// Keeps the GPU tyre solver's ground grid and nearby rocks centred on the car.
function updateGpuTyreWorld(world, vehicle) {
  const { solver } = vehicle.controller.gpu;
  const p = vehicle.body.translation();
  const { heightAt } = world.get(HeightField);
  updateGpuGround(solver, heightAt, p.x, p.z, world.get(Deformation)?.map);
  // Refresh the rock set when the car has moved a few metres.
  const last = solver.rockCentre;
  if (!last || Math.hypot(last.x - p.x, last.z - p.z) > 3) {
    const rocks = [];
    world.query(RockField).forEach((e) => rocks.push(...e.get(RockField).rocks));
    updateGpuRocks(solver, rocks, p.x, p.z);
    solver.rockCentre = { x: p.x, z: p.z };
  }
}

// Fixed-step simulation so the car behaves the same at any frame rate. With GPU tyres each
// step waits for the GPU's hub forces, so this is async.
export async function stepPhysics(world) {
  const physics = world.get(Physics);
  const { delta } = world.get(Time);
  const input = world.get(Input);
  physics.accumulator = Math.min(physics.accumulator + delta, 0.1);

  const vehicles = [];
  world.query(Vehicle).updateEach(([vehicle]) => vehicles.push(vehicle));
  for (const v of vehicles) if (v.controller.gpu) updateGpuTyreWorld(world, v);

  const t0 = performance.now();
  let steps = 0;
  while (physics.accumulator >= physics.step) {
    steps++;
    physics.accumulator -= physics.step;
    const last = physics.accumulator < physics.step;
    for (const vehicle of vehicles) {
      applyDriverInput(vehicle, input, physics.step);
      vehicle.controller.updateVehicle(physics.step);
      // Read tyre positions back once per frame, on the last step, for drawing.
      if (vehicle.controller.gpu) await vehicle.controller.stepTyres({ readPositions: last });
      vehicle.speed = vehicle.controller.currentVehicleSpeed();
    }
    physics.world.step();
  }
  if (steps) physics.stepMs = physics.stepMs * 0.95 + ((performance.now() - t0) / steps) * 0.05;
}

export function syncBodies(world) {
  world.query(RigidBody, Transform).updateEach(([rb, transform]) => {
    const p = rb.body.translation();
    const q = rb.body.rotation();
    transform.position.x = p.x;
    transform.position.y = p.y;
    transform.position.z = p.z;
    transform.quaternion.x = q.x;
    transform.quaternion.y = q.y;
    transform.quaternion.z = q.z;
    transform.quaternion.w = q.w;
  });
}
