// The AI drivers: every car with a driver (its Vehicle's `driver`, see ai/driver.js) gets its pedals
// and steering from it each frame, in its Vehicle's `input`. A driver that asks to be put back on
// the line (stuck, or on its roof) is respawned on the course where it was, clear of the others.
import { HeightField, Time, Vehicle } from '../ecs/traits.js';
import { requestCarRespawn } from '../vehicle/spawn.js';

export function updateDrivers(world) {
  const { delta } = world.get(Time);
  if (!delta) return;
  const cars = [];
  world.query(Vehicle).forEach((entity) => cars.push({ entity, vehicle: entity.get(Vehicle) }));
  const states = cars.map(({ vehicle }) => carState(vehicle));
  cars.forEach(({ entity, vehicle }, i) => {
    const driver = vehicle.driver;
    if (!driver) return;
    const others = states.filter((_, j) => j !== i);
    vehicle.input = driver.update(states[i], others, delta);
    if (driver.respawn) {
      driver.respawn = false;
      respawnOnCourse(world, entity, driver, others);
    }
  });
}

// What a driver needs of a car: where it is, which way it faces, which way is up, its speed.
function carState(vehicle) {
  const p = vehicle.body.translation();
  const q = vehicle.body.rotation();
  // Chassis forward (+x) flattened, and the chassis up (+y) against the world's.
  let fx = 1 - 2 * (q.y * q.y + q.z * q.z);
  let fz = 2 * (q.x * q.z - q.w * q.y);
  const fl = Math.hypot(fx, fz) || 1;
  fx /= fl;
  fz /= fl;
  const up = 1 - 2 * (q.x * q.x + q.z * q.z);
  return { x: p.x, z: p.z, fx, fz, up, speed: vehicle.speed ?? 0 };
}

const SPOT_CLEAR = 7; // m along the course to the nearest other car
// Back on the line a few metres behind where it was (where it got stuck is often the problem),
// facing the way round, stepped back further while another car is in the way.
function respawnOnCourse(world, car, driver, others) {
  const { course } = driver;
  const { heightAt } = world.get(HeightField);
  let s = course.wrap(driver.s - 3);
  for (let k = 0; k < 10; k++) {
    const busy = others.some((o) => Math.abs(course.delta(s, course.locate(o.x, o.z, s).s)) < SPOT_CLEAR && Math.abs(course.locate(o.x, o.z, s).d) < 3.5);
    if (!busy) break;
    s = course.wrap(s - SPOT_CLEAR);
  }
  const p = course.at(s);
  requestCarRespawn(world, heightAt, car, p.x, p.z, Math.atan2(-p.tz, p.tx));
  driver.s = s;
}
