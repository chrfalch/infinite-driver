import { describe, expect, it } from 'vitest';
import { createCourse, gridSpot, speedProfile } from '../src/ai/course.js';
import { createDriver } from '../src/ai/driver.js';
import { createHeightField } from '../src/terrain/height.js';
import { LANE_HALF } from '../src/terrain/stadium.js';
import { CAR } from '../src/vehicle/config.js';

const stadium = createHeightField({ mode: 'stadium' });
const course = createCourse(stadium);

describe('AI course', () => {
  it('is the stadium loop, from the start line round', () => {
    expect(createCourse(createHeightField({ mode: 'canyon' }))).toBeNull();
    expect(course.length).toBeCloseTo(stadium.track.length, 6);
    for (let s = 0; s < course.length; s += 7.3) {
      const p = course.at(s);
      const q = stadium.sample(p.x, p.z);
      expect(Math.abs(q.d)).toBeLessThan(0.05);
      expect(Math.abs(course.delta(s, q.s))).toBeLessThan(0.05);
      // The way round agrees with the stadium's.
      expect(p.tx * q.tx + p.tz * q.tz).toBeGreaterThan(0.999);
    }
    // The start, facing +x; the first corner (round the C's bottom end) turns left.
    const start = course.at(0);
    for (const [key, value] of Object.entries({ x: 0, z: 0, tx: 1, tz: 0 })) expect(start[key]).toBeCloseTo(value, 6);
    let s = 0;
    while (course.at(s).curvature === 0) s += 1;
    expect(course.at(s + 2).curvature).toBeGreaterThan(0);
  });

  it('finds where a car is, across the lane too', () => {
    for (let s = 3; s < course.length; s += 11) {
      for (const d of [-3, 0, 2.5]) {
        const p = course.at(s);
        const x = p.x + p.tz * d;
        const z = p.z - p.tx * d;
        const at = course.locate(x, z, s + 4);
        expect(Math.abs(course.delta(s, at.s))).toBeLessThan(0.6);
        expect(at.d).toBeCloseTo(d, 0);
        // Without a hint as well.
        expect(Math.abs(course.delta(s, course.locate(x, z).s))).toBeLessThan(0.6);
      }
    }
  });

  it('slows for the hairpins and the water hole, braking well before them', () => {
    const v = speedProfile(course);
    const max = Math.max(...v);
    const min = Math.min(...v);
    expect(max).toBeGreaterThan(15);
    expect(min).toBeLessThan(10);
    // In the tightest corner (7.5 m), about sqrt(8 * 7.5).
    const tight = [...course.curvature].reduce((i, k, j, a) => (Math.abs(k) > Math.abs(a[i]) ? j : i), 0);
    expect(v[tight]).toBeLessThan(Math.sqrt(8 * 7.5) + 0.1);
    // Never more than braking allows from one sample to the next.
    for (let i = 0; i < course.n; i++) {
      const next = v[(i + 1) % course.n];
      expect(v[i] * v[i] - next * next).toBeLessThanOrEqual(2 * 6 * course.step + 1e-6);
    }
  });

  it('puts the grid two abreast on the start straight and behind it', () => {
    const spots = [0, 1, 2, 3, 4, 5].map((n) => gridSpot(course, n));
    for (const p of spots) {
      const at = stadium.sample(p.x, p.z);
      expect(Math.abs(at.d)).toBeCloseTo(2.3, 1);
      expect(Math.abs(at.d)).toBeLessThan(LANE_HALF - 1.5);
    }
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) expect(Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z)).toBeGreaterThan(4.5);
    }
    expect(spots[0].yaw).toBeCloseTo(0, 6);
  });
});

// A car as a bicycle: speed from the pedals, heading from the steering, as applyDriverInput steers
// (speed-sensitive lock, steering rate). Enough to show the driver keeps to the lane round a lap.
function simulate(driver, { seconds, dt = 1 / 60, start = gridSpot(course, 1), others = () => [] }) {
  const car = { x: start.x, z: start.z, yaw: start.yaw, v: 0, wheel: 0 };
  let worst = 0;
  for (let t = 0; t < seconds; t += dt) {
    const state = { x: car.x, z: car.z, fx: Math.cos(car.yaw), fz: -Math.sin(car.yaw), up: 1, speed: car.v };
    const input = driver.update(state, others(t), dt);
    const limit = CAR.maxSteer / (1 + Math.abs(car.v) * 0.06);
    const target = input.steer * limit;
    car.wheel += Math.max(-CAR.steerRate * dt, Math.min(CAR.steerRate * dt, target - car.wheel));
    const accel = input.throttle * 5 - (car.v > 0.5 ? input.brake * 8 : 0) - 0.002 * car.v * car.v;
    car.v = Math.max(0, car.v + accel * dt);
    // Positive wheel angle turns left: yaw grows.
    car.yaw += ((car.v * Math.tan(car.wheel)) / CAR.wheelBase) * dt;
    car.x += Math.cos(car.yaw) * car.v * dt;
    car.z -= Math.sin(car.yaw) * car.v * dt;
    worst = Math.max(worst, Math.abs(stadium.sample(car.x, car.z).d));
  }
  return { car, worst };
}

describe('AI driver', () => {
  it('drives laps of the stadium without leaving the lane', () => {
    const driver = createDriver(course);
    const { worst } = simulate(driver, { seconds: 90 });
    expect(driver.lap).toBeGreaterThanOrEqual(2);
    // Inside the rails (the car is 1.25 m half-wide).
    expect(worst).toBeLessThan(LANE_HALF - 1.25);
    expect(driver.mode).toBe('drive');
  });

  it('backs off and tries again when it makes no progress', () => {
    const driver = createDriver(course);
    const p = gridSpot(course, 0);
    // A car that never moves (against a rail, say).
    const state = { x: p.x, z: p.z, fx: 1, fz: 0, up: 1, speed: 0 };
    let reversed = false;
    for (let t = 0; t < 3; t += 1 / 60) {
      const input = driver.update(state, [], 1 / 60);
      if (driver.mode === 'reverse') {
        reversed = true;
        expect(input.brake).toBe(1);
        expect(input.throttle).toBe(0);
      }
    }
    expect(reversed).toBe(true);
    // Stuck again and again: it asks to be put back on the line.
    let asked = false;
    for (let t = 0; t < 15 && !asked; t += 1 / 60) {
      driver.update(state, [], 1 / 60);
      asked = driver.respawn;
    }
    expect(asked).toBe(true);
  });

  it('asks to be put back when it lies on its roof', () => {
    const driver = createDriver(course);
    const p = gridSpot(course, 0);
    for (let t = 0; t < 2 && !driver.respawn; t += 1 / 60) driver.update({ x: p.x, z: p.z, fx: 1, fz: 0, up: -0.9, speed: 0 }, [], 1 / 60);
    expect(driver.respawn).toBe(true);
  });

  it('pulls out to pass a slower car ahead, or slows behind it', () => {
    const driver = createDriver(course, { seed: 0 });
    // A slow car on the line 10 m up the start straight.
    const slow = { x: 30, z: 0, speed: 3 };
    const start = { x: 18, z: 0, yaw: 0 };
    let maxD = 0;
    simulate(driver, {
      seconds: 3,
      start,
      others: (t) => {
        maxD = Math.max(maxD, Math.abs(driver.d));
        return [{ ...slow, x: slow.x + slow.speed * t }];
      },
    });
    // It moved over by about a car's width.
    expect(maxD).toBeGreaterThan(1.8);
  });
});
