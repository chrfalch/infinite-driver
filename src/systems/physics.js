import { Input, Physics, RigidBody, Time, Transform, Vehicle } from '../ecs/traits.js';
import { applyDriverInput } from '../vehicle/physics.js';

// Fixed-step simulation so the car behaves the same at any frame rate.
export function stepPhysics(world) {
  const physics = world.get(Physics);
  const { delta } = world.get(Time);
  const input = world.get(Input);
  physics.accumulator = Math.min(physics.accumulator + delta, 0.1);

  const t0 = performance.now();
  let steps = 0;
  while (physics.accumulator >= physics.step) {
    steps++;
    world.query(Vehicle).updateEach(([vehicle]) => {
      applyDriverInput(vehicle, input, physics.step);
      vehicle.controller.updateVehicle(physics.step);
      vehicle.speed = vehicle.controller.currentVehicleSpeed();
    });
    physics.world.step();
    physics.accumulator -= physics.step;
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
