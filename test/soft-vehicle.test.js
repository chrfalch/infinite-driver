import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { GROUP, groups } from '../src/tire/soft-tire.js';
import { Drivetrain, DEFAULT_DRIVETRAIN } from '../src/vehicle/drivetrain.js';
import { applyDriverInput } from '../src/vehicle/physics.js';
import { createSoftCarBody, softCarRideHeight } from '../src/vehicle/soft-vehicle.js';

const DT = 1 / 120;
const idle = { throttle: 0, brake: 0, steer: 0, handbrake: false };

beforeAll(async () => {
  await RAPIER.init();
});

describe('jointed car on soft tyres', () => {
  it('stands on its suspension, drives straight, and brakes hard', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = DT;
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(500, 1, 500).setTranslation(0, -1, 0).setFriction(1).setCollisionGroups(groups(GROUP.WORLD, 0xffff)),
    );
    const state = { ...createSoftCarBody(RAPIER, world, { x: 0, y: softCarRideHeight(), z: 0 }), steer: 0, drivetrain: new Drivetrain({ ...DEFAULT_DRIVETRAIN }) };
    const run = (seconds, input) => {
      for (let t = 0; t < seconds; t += DT) {
        applyDriverInput(state, input, DT);
        state.controller.updateVehicle(DT);
        world.step();
      }
    };

    run(3, idle);
    const lengths = [0, 1, 2, 3].map((i) => state.controller.wheelSuspensionLength(i));
    console.log('suspension (m)', lengths.map((l) => l.toFixed(3)).join(' '), 'ride y', state.body.translation().y.toFixed(3));
    for (const l of lengths) {
      expect(l).toBeGreaterThan(0.25);
      expect(l).toBeLessThan(0.5);
    }

    run(4, { ...idle, throttle: 1 });
    const p = state.body.translation();
    const kmh = state.controller.currentVehicleSpeed() * 3.6;
    console.log('after 4 s full throttle', kmh.toFixed(1), 'km/h, sideways drift', p.z.toFixed(2), 'm over', p.x.toFixed(1), 'm');
    expect(kmh).toBeGreaterThan(30);
    expect(Math.abs(p.z) / p.x).toBeLessThan(0.03);

    const v0 = state.controller.currentVehicleSpeed();
    let t = 0;
    for (; t < 5 && state.controller.currentVehicleSpeed() > 1; t += DT) run(DT, { ...idle, brake: 1 });
    const decel = (v0 - 1) / t / 9.81;
    console.log('braking (g)', decel.toFixed(2));
    expect(decel).toBeGreaterThan(0.6);
    const r = state.body.rotation();
    expect(1 - 2 * (r.x * r.x + r.z * r.z)).toBeGreaterThan(0.95);
  }, 30000);
});
