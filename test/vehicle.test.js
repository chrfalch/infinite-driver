import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { CAR } from '../src/vehicle/config.js';
import { applyDriverInput, createCarBody } from '../src/vehicle/physics.js';
import { generateRocks } from '../src/terrain/rocks.js';

const DT = 1 / 120;
beforeAll(async () => {
  await RAPIER.init();
});

function setup() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 1, 5000).setTranslation(0, -1, 0));
  const car = createCarBody(RAPIER, world, { x: 0, y: 1.2, z: 0 });
  const state = { ...car, steer: 0 };
  const run = (seconds, input, onStep) => {
    for (let t = 0; t < seconds; t += DT) {
      applyDriverInput(state, input, DT);
      state.controller.updateVehicle(DT);
      world.step();
      onStep?.();
    }
  };
  return { world, state, run };
}

const idle = { throttle: 0, brake: 0, steer: 0, handbrake: false };
const speed = (s) => Math.hypot(s.body.linvel().x, s.body.linvel().z);

describe('car physics', () => {
  it('settles on its suspension with sensible sag', () => {
    const { state, run } = setup();
    run(3, idle);
    const sag = [0, 1, 2, 3].map((i) => CAR.suspensionRestLength - state.controller.wheelSuspensionLength(i));
    console.log('sag (m)', sag.map((s) => s.toFixed(3)).join(' '), 'y', state.body.translation().y.toFixed(3));
    for (const s of sag) {
      expect(s).toBeGreaterThan(0.06);
      expect(s).toBeLessThan(0.24);
    }
    expect(speed(state.body ? state : state)).toBeLessThan(0.05);
  });

  it('accelerates 0-100 km/h in a plausible time', () => {
    const { state, run } = setup();
    run(2, idle);
    let t = 0;
    let t100 = null;
    run(20, { ...idle, throttle: 1 }, () => {
      t += DT;
      if (t100 === null && speed(state) >= 27.78) t100 = t;
    });
    console.log('0-100 km/h (s)', t100?.toFixed(2), 'speed after 20 s (km/h)', (speed(state) * 3.6).toFixed(1));
    expect(t100).not.toBeNull();
    expect(t100).toBeGreaterThan(7);
    expect(t100).toBeLessThan(15);
  });

  it('brakes from 100 km/h at close to 1 g', () => {
    const { state, run } = setup();
    run(2, idle);
    state.body.setLinvel({ x: 27.78, y: 0, z: 0 }, true);
    run(0.3, idle);
    const v0 = speed(state);
    let t = 0;
    run(8, { ...idle, brake: 1 }, () => {
      if (state.body.linvel().x > 1) t += DT;
    });
    const decel = (v0 - 1) / t / 9.81;
    console.log('braking decel (g)', decel.toFixed(2));
    expect(decel).toBeGreaterThan(0.6);
    expect(decel).toBeLessThan(1.2);
  });

  it('slows to a stop off the accelerator, more gently than braking', () => {
    const { state, run } = setup();
    run(2, idle);
    state.body.setLinvel({ x: 13.9, y: 0, z: 0 }, true); // 50 km/h
    let t = 0;
    run(15, idle, () => {
      if (state.body.linvel().x > 0.3) t += 1 / 120;
    });
    const decel = (13.9 - 0.3) / t / 9.81;
    console.log('coast 50 km/h to stop (s)', t.toFixed(2), 'decel (g)', decel.toFixed(2));
    expect(t).toBeGreaterThan(3);
    expect(t).toBeLessThan(8);
    expect(state.body.linvel().x).toBeLessThan(0.05);
  });

  it('turns and holds plausible lateral grip', () => {
    const { state, run } = setup();
    run(2, idle);
    state.body.setLinvel({ x: 16, y: 0, z: 0 }, true);
    let peakLat = 0;
    let prev = state.body.linvel();
    run(4, { ...idle, throttle: 0.35, steer: 1 }, () => {
      const v = state.body.linvel();
      const ax = (v.x - prev.x) / DT;
      const az = (v.z - prev.z) / DT;
      const vm = Math.hypot(v.x, v.z) || 1;
      const lat = Math.abs((ax * -v.z + az * v.x) / vm) / 9.81;
      peakLat = Math.max(peakLat, lat);
      prev = { ...v };
    });
    const rot = state.body.rotation();
    const up = 1 - 2 * (rot.x * rot.x + rot.z * rot.z);
    console.log('peak lateral (g)', peakLat.toFixed(2), 'up·y', up.toFixed(3));
    expect(up).toBeGreaterThan(0.9);
    expect(peakLat).toBeGreaterThan(0.5);
    expect(peakLat).toBeLessThan(1.5);
  });

  it('climbs over a rock with visible suspension travel and stays upright', () => {
    const { world, state, run } = setup();
    // A rounded rock, 0.3 m tall, in the path of the left wheels.
    const pts = [];
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      for (const [r, y] of [[0.55, 0], [0.4, 0.2], [0.15, 0.3]]) pts.push(12 + Math.cos(a) * r, y, -0.9 + Math.sin(a) * r);
    }
    world.createCollider(RAPIER.ColliderDesc.convexHull(new Float32Array(pts)));
    run(2, idle);
    const rest = state.controller.wheelSuspensionLength(0);
    let minLen = rest;
    let minUp = 1;
    run(6, { ...idle, throttle: 0.25 }, () => {
      minLen = Math.min(minLen, state.controller.wheelSuspensionLength(0));
      const r = state.body.rotation();
      minUp = Math.min(minUp, 1 - 2 * (r.x * r.x + r.z * r.z));
    });
    console.log('FL rest', rest.toFixed(3), 'min', minLen.toFixed(3), 'x', state.body.translation().x.toFixed(1), 'min up', minUp.toFixed(3));
    expect(rest - minLen).toBeGreaterThan(0.12);
    expect(minUp).toBeGreaterThan(0.9);
    expect(state.body.translation().x).toBeGreaterThan(15);
  });
});

describe('rocks', () => {
  it('are deterministic and keep the spawn area clear', () => {
    const flat = () => 0;
    const a = generateRocks(flat, 0, 0);
    const b = generateRocks(flat, 0, 0);
    expect(a.length).toBeGreaterThan(10);
    expect(Array.from(a[0].vertices)).toEqual(Array.from(b[0].vertices));
    for (const r of [...a, ...generateRocks(flat, -1, -1)]) expect(Math.hypot(r.x, r.z)).toBeGreaterThan(10);
  });
});
