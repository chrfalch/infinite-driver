// An AI driver: works its car's pedals and steering (the same input the keyboard gives the player's
// car, see applyDriverInput) to drive round a course (ai/course.js).
//
// - Steering: pure pursuit. A point on the line a lookahead ahead (further the faster the car goes),
//   moved across the lane to pass a car, and the wheel angle whose arc runs through it.
// - Speed: the course's speed profile (corners, braking for them, the features), times the
//   driver's pace; throttle and brake from the gap to it.
// - Traffic: a car close ahead in the way is passed on the side with more room, or followed.
// - Stuck (no progress for a while, against a rail or another car): back off with the wheel the
//   other way, then try again; on its roof, or stuck again and again, it asks to be put back on
//   the line (`respawn`).
//
// The driver is plain state plus `update`, so tests can run it against a course without a world.
import { CAR } from '../vehicle/config.js';
import { speedProfile } from './course.js';

const STUCK_TIME = 2.5; // s with under STUCK_PROGRESS m of progress (and no braking for a corner)
const STUCK_PROGRESS = 1.5;
const REVERSE_TIME = 1.4; // s backing off
const RESPAWN_AFTER = 3; // backing-off tries in a row before it asks to be put back
const UPSIDE_TIME = 1.5; // s on its side or roof
const PASS_RANGE = 14; // m ahead along the course that another car counts as in the way
const CAR_WIDTH = 2.6; // m, with a little room
const CREEP = 2.5; // m/s pulling out round a car that stands

export function createDriver(course, { pace = 1, lateral = 8, braking = 6, vMax = 22, seed = 1 } = {}) {
  const profile = speedProfile(course, { lateral, braking, vMax });
  return {
    course,
    profile,
    pace,
    // Each driver keeps a little to one side of the line, so a pack does not drive in single file.
    lane: ((seed * 0.618) % 1) * 2 - 1,
    s: null, // where it is along the course
    d: 0,
    lap: 0, // laps completed since it started
    progress: 0, // m driven along the course, all laps
    mode: 'drive',
    modeTime: 0,
    window: { time: 0, progress: 0 },
    tries: 0,
    upside: 0,
    offset: 0, // the lateral offset it is steering for (m, left positive)
    respawn: false, // set when it wants to be put back on the line (see systems/ai.js)
    input: { throttle: 0, brake: 0, steer: 0, handbrake: false },
    update(car, others, dt) {
      return drive(this, car, others, dt);
    },
  };
}

// car: { x, z, fx, fz (unit forward), up (the chassis' up . world up), speed (m/s, forward +) }.
// others: other cars' { x, z, speed }.
function drive(driver, car, others, dt) {
  const { course, input } = driver;
  const prev = driver.s;
  const here = course.locate(car.x, car.z, prev);
  // Starting behind the line (on the grid), the first crossing starts lap 0.
  if (prev === null && here.s > course.length / 2) driver.lap = -1;
  if (prev !== null) {
    const ds = course.delta(prev, here.s);
    driver.progress += ds;
    // Over the line (forwards) means a lap.
    if (ds > 0 && course.wrap(prev) > course.length - 20 && here.s < 20) driver.lap++;
    else if (ds < 0 && here.s > course.length - 20 && course.wrap(prev) < 20) driver.lap--;
  }
  driver.s = here.s;
  driver.d = here.d;
  const v = car.speed;
  driver.modeTime += dt;

  // On its side or roof: nothing to do but be put back.
  driver.upside = car.up < 0.3 ? driver.upside + dt : 0;
  if (driver.upside > UPSIDE_TIME) return askRespawn(driver);

  if (driver.mode === 'reverse') {
    if (driver.modeTime > REVERSE_TIME) setMode(driver, 'drive');
    else return backOff(driver, car);
  }

  // The speed to drive at: the profile here and a little ahead (it is lower before a corner), the
  // traffic, and the driver's pace.
  const i = Math.floor(here.s / course.step) % course.n;
  let target = driver.profile[i] * driver.pace;
  const ahead = traffic(driver, others);
  // Pass on the side with more room (toward the inside of the next corner on a tie), keeping to
  // the lane; with no room, follow.
  const wanted = ahead ? passOffset(driver, ahead) : driver.lane * 0.8;
  // Not beside it yet: no faster than it, but with room to pass a car that stands (on the grid, or
  // stuck) creep out round it. With no room, follow.
  const room = ahead && Math.abs(wanted - ahead.d) >= CAR_WIDTH - 0.1;
  if (ahead && (!room || (Math.abs(driver.d - ahead.d) < CAR_WIDTH && ahead.gap < 7))) {
    target = Math.min(target, Math.max(room ? CREEP : 0, ahead.speed - 0.5));
  }
  driver.offset += (wanted - driver.offset) * Math.min(1, dt / 0.6);
  driver.target = target; // (for debugging and tests)

  const lookahead = Math.min(14, 4 + 0.55 * Math.abs(v));
  input.steer = steerFor(driver, car, lookahead, driver.offset);

  // Pedals: throttle up to the target, brake above it. Below walking pace the brake pedal would
  // back up, so it only brakes when moving.
  const error = target - v;
  input.throttle = error > 0 ? Math.min(1, 0.25 + error * 0.35) : 0;
  input.brake = error < -0.6 && v > 0.6 ? Math.min(1, -error * 0.3) : 0;
  input.handbrake = false;
  // Rolling backwards in drive (after backing off, or down a slope): drive forwards.
  if (v < -0.5) {
    input.throttle = 1;
    input.brake = 0;
  }

  // Stuck: hardly any progress for a while though it wants to go.
  const w = driver.window;
  w.time += dt;
  if (w.time > STUCK_TIME) {
    const moved = driver.progress - w.progress;
    w.time = 0;
    w.progress = driver.progress;
    if (moved < STUCK_PROGRESS && target >= CREEP) {
      driver.tries++;
      if (driver.tries >= RESPAWN_AFTER) return askRespawn(driver);
      setMode(driver, 'reverse');
      return backOff(driver, car);
    } else if (moved > 10) driver.tries = 0;
  }
  return input;
}

// Back off, the wheel turned the other way to the line ahead, so the nose comes round to it.
function backOff(driver, car) {
  const { input } = driver;
  const steer = steerFor(driver, car, 6, 0);
  input.throttle = 0;
  input.brake = 1; // at a standstill (and in reverse) the brake pedal backs up
  input.steer = -Math.sign(steer || 1);
  input.handbrake = false;
  return input;
}

function setMode(driver, mode) {
  driver.mode = mode;
  driver.modeTime = 0;
  driver.window.time = 0;
  driver.window.progress = driver.progress;
}

function askRespawn(driver) {
  driver.respawn = true;
  driver.tries = 0;
  driver.upside = 0;
  setMode(driver, 'drive');
  Object.assign(driver.input, { throttle: 0, brake: 0, steer: 0, handbrake: false });
  return driver.input;
}

// The steering input (-1..1, left positive) toward the point `lookahead` m ahead on the course,
// `offset` m to the left of the line.
const point = {};
function steerFor(driver, car, lookahead, offset) {
  const { course } = driver;
  const p = course.at(driver.s + lookahead, point);
  // Left of the way round is (tz, -tx).
  const px = p.x + p.tz * offset - car.x;
  const pz = p.z - p.tx * offset - car.z;
  // In the car's frame: forward (fx, fz), its left (fz, -fx).
  const forward = px * car.fx + pz * car.fz;
  const left = px * car.fz - pz * car.fx;
  const alpha = Math.atan2(left, forward);
  const distance = Math.hypot(px, pz);
  const wheel = Math.atan2(2 * CAR.wheelBase * Math.sin(alpha), distance);
  // As applyDriverInput limits the wheel at speed: full input is this much lock.
  const limit = CAR.maxSteer / (1 + Math.abs(car.speed) * 0.06);
  return Math.max(-1, Math.min(1, wheel / limit));
}

// The nearest other car ahead along the course and near enough across it to be in the way, or to
// be passed: { gap, d, speed }. (Measured from where this car is, not where it is heading, so it
// keeps its passing line until it is by.)
function traffic(driver, others) {
  const { course } = driver;
  let best = null;
  for (const o of others) {
    const at = course.locate(o.x, o.z, driver.s);
    const gap = course.delta(driver.s, at.s);
    if (gap <= 0 || gap > PASS_RANGE) continue;
    if (Math.abs(at.d - driver.d) > CAR_WIDTH + 2) continue;
    if (!best || gap < best.gap) best = { gap, d: at.d, speed: o.speed };
  }
  return best;
}

// Where across the lane to pass the car ahead: beside it on the side with more room.
function passOffset(driver, ahead) {
  const half = driver.course.halfWidth;
  const left = ahead.d + CAR_WIDTH;
  const right = ahead.d - CAR_WIDTH;
  const leftOk = left <= half;
  const rightOk = right >= -half;
  if (leftOk && rightOk) {
    // Toward the inside of what comes next.
    const k = driver.course.at(driver.s + 15, point).curvature;
    if (Math.abs(k) > 0.01) return k > 0 ? left : right;
    return Math.abs(left - driver.offset) < Math.abs(right - driver.offset) ? left : right;
  }
  if (leftOk) return left;
  if (rightOk) return right;
  // No room either side: stay behind it.
  return Math.max(-half, Math.min(half, ahead.d));
}
